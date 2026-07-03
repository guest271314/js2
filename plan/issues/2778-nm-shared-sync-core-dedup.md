---
id: 2778
title: "Dedup native-messaging sync framing: share one host-independent core for nm_deno + nm_node_fs"
status: done
assignee: ttraenkler/dev-2778-nm-dedup
created: 2026-06-28
completed: 2026-06-28
priority: medium
feasibility: medium
task_type: refactor
area: examples
goal: platform
related: [2775, 2771, 389, 2655, 2779]
sprint: 69
---

# #2778 — share one sync framing core for nm_deno + nm_node_fs

## Problem

After #2775 renamed the Native Messaging examples to the host scheme, `nm_deno.ts`
(Deno `readSync`/`writeSync`) and `nm_node_fs.ts` (`node:fs` `readSync`/`writeSync`)
were MONOLITHIC: each re-implemented the whole Native Messaging framing/streaming
protocol (4-byte LE length prefix, body streaming, framed response, zero-length
shutdown frame, EOF handling). The two differ only in (a) which host stdio they
call and (b) whether they re-chunk to the browser 1 MiB per-message cap — yet they
duplicated the entire protocol loop. The dedup was blocked until #2771 made the
CLI bundle relative imports for standalone WASI.

## Fix

Extract a shared, **host-INDEPENDENT** core — `examples/native-messaging/nm_sync_framing.ts`
— that owns the framing/streaming over `Uint8Array` and is parameterized by the
host stdio + an optional re-chunk cap. The two hosts become thin adapters:

- `nm_deno.ts` injects `Deno.stdin.readSync` / `Deno.stdout.writeSync`, **no cap**
  → verbatim byte echo.
- `nm_node_fs.ts` injects `node:fs` `readSync(0,…)` / `writeSync(1,…)`, **cap =
  1 MiB** → keeps its deliberate browser-cap re-chunk demo (a body > 1 MiB streams
  back as a sequence of valid `<=1 MiB` `[run]` / `"run"` JSON frames).

`nm_wasi_p1.ts` (raw linear-memory WASI) and `nm_node_process.ts` (async reactor)
are deliberately NOT touched — they stay standalone.

### The injection seam is two FUNCTION references, not an `NmHostIo` object

The issue originally specified an `NmHostIo { read, write }` **object** seam. That
does not work today: passing a struct/interface VALUE (or a method extracted from
one) across the bundled-module boundary under `--target wasi` compiles clean
(imports = `{wasi_snapshot_preview1}` only) but **traps at runtime** — the
relative-import bundler does not unify the struct's nominal type identity across
files, so the cross-file `call_ref` / field read faults. Passing standalone
**function references** across the boundary works. So the seam is
`runNmHost(read, write, maxFrameSize)`. See #2779 for the compiler follow-up.

## Compiler gaps discovered (worked around here; tracked in #2779)

All four are `node:fs`-multi-file (`compileProject`/`compileMultiSource`) +
`--target wasi` codegen gaps. Each compiles to a clean wasi-only module but then
FAULTS at runtime (or fails `WebAssembly.validate`); the Deno variant (no `node:fs`
shim insertion → no index shift) is unaffected. Worked around in the example
sources so the dedup ships working:

1. **Struct/interface value across the bundle boundary** → fault. Workaround: the
   seam passes function references (`read`, `write`, `log`), not an object.
2. **A shared-module helper returning a nullable reference type** (`Uint8Array |
   null`, e.g. the original `readExactNew`) → fault when bundled into a `node:fs`
   entry. Workaround: every shared reader uses the `boolean`-EOF form
   (`readFillExact`) into a caller-provided buffer; the verbatim path allocates a
   fresh exact-size buffer per run.
3. **A module-level `const` (lowered to a Wasm global) passed as a call argument**
   across the bundle boundary → fault. Workaround: the cap is a LOCAL const inside
   `main()` (compiles to a plain `i32.const` operand).
4. **The number→string path (`number_toString_radix`)** — e.g. a template literal
   `` `…${n}…` `` — compiles to INVALID Wasm in the bundled `node:fs` entry.
   Surfaced restoring nm_node_fs's fd-2 telemetry (`[host] received N chars …`),
   which the real-wasmtime smoke test asserts. Workaround: a hand-rolled decimal
   formatter (`% 10`, `(v - v%10)/10`) instead of template-literal interpolation.

These look like a single underlying defect: `node:fs` shim insertion shifts
function/global/type indices in a multi-file bundle, but some references are not
consistently re-mapped past a threshold. The example sources carry comments at the
exact sites so a future edit does not silently reintroduce a trap; the
native-messaging tests run the binaries under an fd shim, so a regression FAILS CI.

## Verification (acceptance)

Both adapters compile via the real CLI / `compileProject` to a clean standalone
WASI module — imports = `{wasi_snapshot_preview1}` ONLY, no `env::*`, with
`nm_sync_framing.ts` bundled in. Behavior is IDENTICAL to the merged monolithic
versions:

- `nm_deno`: byte-exact verbatim echo at 1 / 64 / 128 MiB.
- `nm_node_fs`: re-chunk round-trip at 1 KiB → 128 MiB — every emitted frame is a
  valid `[…]` within the 1 MiB cap, and concatenating the frame interiors
  reconstructs the original array body exactly; the fd-2 telemetry line is
  byte-exact under real wasmtime (the `smoke` check).

Pinned by `tests/native-messaging-matrix.test.ts` (1/64/128 MiB matrix),
`tests/native-messaging-comparison.test.ts` (#2683/#2696 import-section + echo
harness), `tests/issue-2521-native-messaging-rechunk.test.ts` (linkNodeShims
re-chunk), and `examples/native-messaging/smoke-test.sh` (the `smoke` CI check —
real wasmtime, `--link-node-shims`, asserts stdout frame + fd-2 stderr line). All three route nm_deno/nm_node_fs through `compileProject` (mirroring
the CLI's #2771 `entryHasRelativeImports` dispatch); the other variants stay on
single-source `compile()` so their output is byte-identical. The comparison
harness's variant discovery excludes `nm_sync_framing.ts` (it is the shared core,
not a host variant).
