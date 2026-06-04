---
id: 1863
title: "Uint8Array large-buffer ops are slow (~7-8 s per 64 MiB) vs AssemblyScript/Javy/qjs"
status: backlog
sprint: Backlog
created: 2026-06-04
updated: 2026-06-04
priority: medium
feasibility: hard
reasoning_effort: high
task_type: performance
area: codegen
language_feature: typed-arrays
goal: performance
related: [1865, 389]
---
# #1863 — Uint8Array large-buffer ops are slow vs other runtimes

**Source:** GitHub issue #389 (guest271314): "the execution is slow cf.
AssemblyScript, Javy, `qjs-wasi.wasm`."

## Problem

The Native Messaging host's 64 MiB round trip took ~7–8 s per message under
wasmtime 45. Originally assumed to be element-wise typed-array work — but
measurement showed the **opposite**: the bottleneck is wasmtime's native
`array.copy` on i8 GC arrays (what `Uint8Array.prototype.subarray`/`slice` lower
to), which runs ~14× **slower** than an equivalent element-wise loop.

### Measured (wasmtime 45, 64 MiB `Array(209715*64)`)

| operation | time |
|---|---|
| read 64 MiB into a GC array + one whole-array `process.stdout.write` (element-wise GC→linear in `__wasi_write`) | **0.3 s** |
| 65 × `array.new_default(1 MiB)`, no copy | **0.2 s** |
| 65 × `body.subarray(1 MiB)` (native `array.copy`) | **7.0 s** |
| 64 × 1 MiB **explicit element-copy loop** (`dst[k]=src[k]`) | **0.5 s** |
| null collector (no GC) — same loop | unchanged (GC is **not** the cause) |

So js2wasm already emits the **bulk** `array.copy` instruction
(`emitArrayCopy` in `src/codegen/array-methods.ts`); the slow part is wasmtime's
*execution* of `array.copy` for i8 GC arrays (~9 MiB/s) — strikingly ~30× slower
than the element-wise `array.get_u`+`i32.store8` loop in `__wasi_write` and ~14×
slower than a guest element loop. Likely a wasmtime perf bug (array.copy not
specialized to memmove for packed numeric arrays); worth an upstream report
alongside the GC finding (#12942).

The example host (#1865) was made fast by **avoiding** the copy: it builds each
`[...]` frame with an element-wise loop and writes the whole buffer (1.2 s for
64 MiB, down from 7.4 s).

## Why it matters

Real native-messaging hosts process multi-MiB payloads; a multi-second per
message cost makes js2wasm output uncompetitive and can cause the browser to
buffer/backpressure (a contributor to the originally reported freeze).

## Directions to investigate

- **`subarray`/`slice` as a true view (no copy).** JS `subarray` is spec'd as a
  view over the same buffer; the vec model copies instead (`#1664`). A real view
  (`{length, offset, data}`) would be zero-copy and spec-correct, sidestepping
  `array.copy` entirely. Biggest, cleanest win; larger model change.
- **Do NOT blanket-replace `array.copy` with an element loop in `emitArrayCopy`.**
  It's ~14× faster *on wasmtime*, but on V8/browsers (the gc backend's main
  target) native `array.copy` is memmove-fast and the loop would regress. Any
  element-loop lowering would have to be target-aware — not worth it without data
  on each runtime.
- **Report the `array.copy` slowness upstream to wasmtime** (i8 GC array
  `array.copy` ~9 MiB/s, ~30× slower than an element loop) — analogous to the
  GC grow-vs-collect finding (#12942). This is the real lever.
- Benchmark against AssemblyScript/Javy/qjs on the 1 MiB and 64 MiB cases and
  track the ratio in `compare-memory.mjs`.

## Acceptance criteria

- 64 MiB round trip wall time within ~2–3× of AssemblyScript (the example host
  is already at 1.2 s via the element-loop workaround; the general fix is the
  view and/or the wasmtime `array.copy` improvement).
- No correctness regression in `tests/issue-1530.test.ts` / `smoke-test.sh`.
