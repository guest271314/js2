---
id: 2807
title: "nm_node_process (async process.stdin) emits ZERO output at 128 MiB under real wasmtime — and the in-process shim masks it"
status: ready
created: 2026-06-28
updated: 2026-06-28
priority: high
feasibility: hard
task_type: bug
area: runtime
language_feature: native-messaging
goal: platform
sprint: current
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
