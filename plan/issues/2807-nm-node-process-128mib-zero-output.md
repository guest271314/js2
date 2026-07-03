---
id: 2807
title: "nm_node_process (async process.stdin) emits ZERO output at 128 MiB under real wasmtime — and the in-process shim masks it"
status: done
assignee: ttraenkler/sendev-2807
completed: 2026-06-28
created: 2026-06-28
updated: 2026-07-03
priority: high
feasibility: hard
task_type: bug
area: runtime
language_feature: native-messaging
goal: platform
sprint: 69
horizon: l
related: [389, 2754, 2775, 2777, 1767]
---

# nm_node_process zero-output at 128 MiB (real wasmtime)

## Problem

During an all-variants × all-sizes verification of the #2754 fix — each
Native-Messaging host **bun-transpiled** (the reporter's exact flow,
loopdive/js2#389) and run under **real wasmtime v46.0.1** — three of the four
variants round-trip byte-exact at 1 / 64 / 128 MiB, but **`nm_node_process`
(the async `process.stdin` reactor variant) produces ZERO output at 128 MiB**
(exit 0), while 1 MiB and 64 MiB are byte-exact.

| variant (bun → `--target wasi` → wasmtime v46) | 1 MiB | 64 MiB | 128 MiB |
| ---------------------------------------------- | ----- | ------ | ------- |
| nm_deno (verbatim)                             | ✅    | ✅     | ✅ (4.0s) |
| nm_node_fs (re-chunk)                          | ✅    | ✅     | ✅ (4.9s) |
| nm_wasi_p1 (linear)                            | ✅    | ✅     | ✅ (10.5s) |
| **nm_node_process (async)**                    | ✅ (0.5s) | ✅ (7.9s) | ✗ **0 bytes, exit 0 (38s)** |

It is **not a timeout** (completes in ~38s) and **not the #2754 funcref bug**
(that is fixed and verified byte-exact for the other three variants). It is a
distinct **async-reactor-at-scale** failure that only manifests on the large
payload.

## Repro

```bash
bun build examples/native-messaging/nm_node_process.ts --outfile /tmp/p.js   # --target=node default
node <fixed-cli> /tmp/p.js --target wasi -o /tmp
#   frame = 4-byte LE length (134217728) + 128 MiB body
printf '<frame>' | wasmtime -W gc=y,function-references=y,tail-call=y,exceptions=y /tmp/nm_node_process.js.wasm
#   → 0 bytes out, exit 0   (64 MiB body → byte-exact echo)
```

## The coverage hole (why CI is green)

`tests/native-messaging-matrix.test.ts` (#2775) asserts `nm_node_process`
echoes 1 / 64 / 128 MiB byte-exact — but it drives the module through an
**in-process reactor shim** (`runReactorShim`), **not real wasmtime**, so it
passes while real wasmtime fails. This is the **same class of false-green** as
the #2754 test bundling with **esbuild** instead of the reporter's **bun**
(esbuild's nm_node_fs worked; bun's needed `--target node`, and bun's default
browser target silently stubs `node:fs`).

## Hypothesis (to confirm)

- A scale/memory or buffer-growth issue specific to the async read path — the
  #2777 amortized-growth byte buffer, or a `memory.grow` cap, or a size/offset
  computation that breaks at ~128 MiB (cf. #1767 64-MiB memory growth). The
  doubling 64 → 128 MiB is suggestive of a growth/allocation ceiling.
- Bisect the threshold between 64 and 128 MiB; dump the WAT around the reactor
  read/buffer-grow path; check wasm linear-memory growth + any GC-heap cap under
  wasmtime.

## Scope / acceptance

1. **Fix**: `nm_node_process` bun-transpiled echoes 128 MiB byte-exact under
   real wasmtime v46.
2. **Harden the tests (the #2 decision)** so this can't recur:
   - the transpiled-roundtrip test bundles with **bun** (`--target node`, and
     `--external wasi_snapshot_preview1 --external wasm:memory` for `nm_wasi_p1`),
     not esbuild;
   - add **real-wasmtime** coverage at 1 / 64 / 128 MiB for all four variants
     (the smoke job installs wasmtime; v46 does 128 MiB in seconds), instead of
     relying solely on the in-process shim.
3. Note the wasmtime **v46** dependency — under v44 the `array.copy` perf bug
   inflated these runs 30–60× (302s → 4.9s at 128 MiB); #2271 pins v46.

## Related

- #389 — reporter's bun-transpiled flow; the verification that surfaced this.
- #2754 — the transpiled-`.js` zero-output fix (verified for the other 3).
- #2775 — the matrix test whose in-process shim masks this.
- #2777 — async read-side amortized byte buffer (suspect path).
- #1767 — native-messaging 64-MiB memory growth.

## Root cause (white-box confirmed) + fix

**It was NOT the buffer growth / async reactor / GC allocation.** White-box
tracing of the `nm_node_process` read+drain path showed every byte arrived
(`totalAppended = 134217732`), the full frame was assembled, and `drain()` fired
ONCE with the correct `len = 134217728` — i.e. `process.stdout.write(out)` was
reached with the whole 128 MiB frame — yet `out_size = 0`.

The fault is **`fd_write` itself, in wasmtime**: a hand-written WAT probe (no
js2wasm codegen) that grows memory and issues a single-iovec `fd_write` proved
wasmtime v46 **rejects any single `fd_write` whose iovec length is ≥ ~128 MiB**
— the empirical cap is `len ≤ 0x07FFFFF8` (134217720) OK, `len ≥ 0x07FFFFF9`
returns **errno 48 with `nwritten = 0`**, *identically for a redirected file and
a pipe*. So it is a fixed structural cap (wasmtime bounds the guest→host buffer
it stages per write), not real memory pressure. js2wasm's WASI write helpers map
a non-zero errno to "0 bytes written" and **drop** it, so the host wrote zero
bytes and exited 0 — a silent failure.

Why only `nm_node_process`: it is the ONLY variant that builds the WHOLE
response frame and writes it in ONE `process.stdout.write`. `nm_deno` /
`nm_wasi_p1` stream through a 64 KiB verbatim window and `nm_node_fs` re-chunks
to ≤1 MiB frames — none ever issues a >128 MiB single `fd_write`, which is why
they passed at every size.

**Fix** — a chunked WASI write helper `__wasi_fd_write_all(fd, ptr, len)`
(`src/codegen/index.ts`) that writes in pieces of at most
`WASI_FD_WRITE_MAX_CHUNK` (64 MiB — 2× under the cap, confirmed on file + pipe)
and advances by the ACTUAL `nwritten` each iteration (so a kernel short-write is
handled too — the old single-shot tail ignored `nwritten` entirely). All three
direct-WASI write sites route through it: the linear-backed zero-copy path
(`tryEmitLinearU8StdWrite` — the path `nm_node_process` actually uses), the
GC-array/string/ArrayBuffer tail (`emitWasiWriteTail`), and `node:fs writeSync` /
`Deno.stdout.write` (`emitFdWriteRuntime`). The `--link node:fs` shim path is
unaffected (it forwards to the shim's own `writeSync`).

Index-shift note: `__wasi_fd_write_all` is pre-created at the TOP of each
`ensure*Helper` (before each reserves its own funcidx) so the lazy creation
inside `emitWasiWriteTail` never pushes a function mid-body and shifts the
outer helper's reserved index.

**Verified** byte-exact under REAL wasmtime v46 (bun-transpiled, `--target node`):
`nm_node_process` 128 / 200 / 256 MiB; `nm_deno` & `nm_wasi_p1` 1 + 256 MiB;
`nm_node_fs` round-trips with the node:fs shim. All 18 existing NM unit tests
still pass.

**Coverage hardening (decision #2):**
- `examples/native-messaging/scale-test.mjs` + the `native-messaging-smoke` job
  (now installs **bun**) — bun-bundles all four variants the reporter's way
  (`--target node`; `--external wasi_snapshot_preview1 --external wasm:memory`
  for `nm_wasi_p1`) and round-trips each under **real wasmtime** at
  1/64/128/256 MiB.
- `tests/issue-2807-fd-write-cap.test.ts` — an always-on vitest guard that drives
  `nm_node_process` through a reactor shim whose `fd_write` FAITHFULLY rejects an
  oversized single iovec the way wasmtime does (the #2775 bulk-copy shim could
  not). Proven to FAIL on the pre-fix single-shot write and pass after.
