---
id: 2840
title: nm_js2wasm_node_process .ts-direct compile fails with linear-Uint8 helper-arg #1886 (module-scope buffer)
status: done
sprint: 69
priority: high
area: codegen
task_type: bug
related: [389, 2832, 1886]
assignee: ttraenkler/senior-dev-2840
completed: 2026-06-29
---

## Problem

Compiling the Native-Messaging host **directly as `.ts`** —
`js2wasm examples/native-messaging/nm_js2wasm_node_process.ts --target wasi`
(NOT bun-bundled to `.js` first) — failed with four:

> `Codegen error: linear Uint8Array helper argument is not backed by linear memory (#1886)`

at the four `win` arguments of the re-chunk helpers (`drainArrayFinal(win)`,
`emitArrayWindow(win)`, `emitFrame(win, …)` ×2).

The #2832 read-side rewrite introduced a module-scope `Uint8Array` re-chunk
window (`const win = new Uint8Array(FRAME_CAP)`) plus one-level helper functions
that read it. On the **`.ts`-direct** path (full type info → the
linear-`Uint8Array` analysis in `src/codegen/linear-uint8-analysis.ts`,
#1886/#2045 runs) `win` was seeded as a linear-safe candidate and the helper
params were rewritten to `(ptr,len)`. But codegen cannot back a **module-scope**
buffer linearly — so the helper-arg threading hit the reportError. On the
**`.js`** path (bun strips types → `Uint8Array` is dynamic/`any`) the analysis
never seeds, so it stayed on the GC path (which hits the separate #2311
externref-vec bug, fixed under #2839). The NM scale-test only exercises the
`.js` path, which is why this slipped #2832's verification.

## Root cause

`tryEmitLinearU8New` (the #1886 codegen lowering, `linear-uint8-codegen.ts`)
allocates a buffer's `(ptr,len)` pair as **locals of the function the
`new Uint8Array(...)` is compiled in**, and registers them in that function's
_per-function_ `fctx.linearU8Buffers` registry. For a **module-scope**
`const win = new Uint8Array(...)` the `new` is compiled in the **module-init**
frame:

- its `(ptr,len)` locals live in module-init and are unreachable from every
  _other_ function that references `win` (the state machine's
  `onData`/`emitFrame`/`emitArrayWindow`/`drainArrayFinal`), and
- the module-global GC storage is skipped (variables.ts treats it as
  linear-backed),

so a module-scope buffer classified linear-safe is **wholly inaccessible**.
When such a buffer is then threaded into a helper whose param the analysis
rewrote to `(ptr,len)`, the call site's `getLinearU8Buffer(win)` returns
`undefined` → the "not backed by linear memory" reportError (#1886). A
module-scope linear buffer would need _global_ `(ptr,len)` backing, which the
current per-function codegen does not implement.

The analysis was therefore over-approximating: it admitted a classification the
codegen cannot honor.

## Fix — (b) compiler fix (analysis tightening), localized

`src/codegen/linear-uint8-analysis.ts` — seed only **function-local**
`new Uint8Array(...)` bindings as linear candidates. A new `isInsideFunction`
helper gates the candidate seed in Pass 1; a module-scope binding (no
function-like ancestor) is left on the GC path (a wasm global), exactly as the
`.js`/dynamic path already does. The analysis is monotone and only ever
_demotes_, so this is strictly safe: helper params fed only a (now non-safe)
module-scope buffer demote in the existing fixpoint, no signature rewrite
happens, and no #1886 error is raised. Function-local buffers (every existing
#1886/#2045 case) are unchanged.

This is option (b) from the issue, but in the _tightening_ direction (the
analysis was too **permissive**, not too conservative): it admitted a
module-scope pattern codegen cannot back. Option (a) example rework was not
viable — a streaming state machine's window must persist across async `'data'`
callbacks, so it cannot be a function-local, and module-globals are precisely
what the analysis must skip. The GC path for the one-level-helper read pattern
already compiles+runs (it is what the `.js` path uses), so demoting `win`/`vbuf`
to GC is the correct, byte-faithful outcome.

## Verification (both compile paths)

`.ts`-direct (`npx tsx src/cli.ts examples/native-messaging/nm_js2wasm_node_process.ts --target wasi -o /tmp/np_ts`):

- compiles with **no #1886 error**, valid wasm, wasm-opt clean.
- runs under `wasmtime -W gc=y,function-references=y,tail-call=y,exceptions=y`:
  - small verbatim frame → **byte-exact** round-trip.
  - > 1 MiB **array** body → 2 valid `[run]` frames, concatenated elements
    > **exact** (400000 elems) — exercises `win`/`emitArrayWindow`/`drainArrayFinal`.
  - > 1 MiB **string** body → 2 valid `"run"` frames, reassembled **exact**
    > (1.5 M chars) — exercises `win`/`emitFrame`.

`.js` path (`node examples/native-messaging/scale-test.mjs`,
`NM_SCALE_SIZES_MIB="1 64 128 256"`, with #2839 merged into this branch):

- **all four** hosts pass byte-exact re-chunk round-trip at every size;
  `nm_js2wasm_node_process` bounded memory (#2832). The `.js` node_process build
  depends on #2839 (the #2311 externref-vec fix) — merged here.

Tests: `tests/issue-2840-module-scope-uint8.test.ts` (4 cases — module-scope not
seeded; function-local still seeded; helper-param demotion; one-level-helper
GC compile clean of #1886).

## Notes

- This branch merges `issue-2839-externref-vec-i8-i16-coerce` so the `.js`
  node_process round-trip can be proven end-to-end. The `.ts`-direct fix (the
  analysis tightening) is what THIS issue owns.
- Pre-existing (NOT caused by this change): the
  `#1886 > classifies every buffer in the native-messaging host as linear-safe`
  test in `tests/issue-1886.test.ts` is stale — `nm_js2wasm_node_fs.ts` was
  refactored to delegate to the shared `nm_js2wasm_sync_framing` core, so its
  single-file `analyze()` no longer sees `header`/`one`/`tmp`/`buf`/`src`. This
  fails identically on `origin/main` without this change.
