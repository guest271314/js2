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
related: [1861, 389]
---
# #1863 — Uint8Array large-buffer ops are slow vs other runtimes

**Source:** GitHub issue #389 (guest271314): "the execution is slow cf.
AssemblyScript, Javy, `qjs-wasi.wasm`."

## Problem

The Native Messaging host's 64 MiB round trip takes ~7–8 s per message under
wasmtime 45 (measured via `examples/native-messaging/compare-memory.mjs`),
dominated by element-wise `Uint8Array` work:

- `readExact` fills a 64 MiB WasmGC `i8` array via per-element `array.set` in a
  read-until loop;
- bulk reads from `fd_read` land in a linear scratch buffer and are copied byte
  by byte into the GC array;
- `subarray`/copy on large arrays appears to allocate/copy per element.

The compiled representation is correct (packed byte lanes since the typed-array
storage fix) but the per-byte loop is the bottleneck. Other WASM toolchains
(AssemblyScript, Javy, qjs-wasi) process the same 64 MiB markedly faster.

## Why it matters

Real native-messaging hosts process multi-MiB payloads; a multi-second per
message cost makes js2wasm output uncompetitive and can cause the browser to
buffer/backpressure (a contributor to the originally reported freeze).

## Directions to investigate

- Bulk-copy fd_read output into the GC array via `array.copy` / `array.init_data`
  (bulk WasmGC array ops) instead of an element loop.
- Make `Uint8Array.prototype.subarray` a true view (no copy) in standalone/WASI
  lowering, or at least a bulk copy.
- Benchmark against AssemblyScript/Javy/qjs on the 1 MiB and 64 MiB cases and
  track the ratio in `compare-memory.mjs`.

## Acceptance criteria

- 64 MiB round trip wall time reduced substantially (target: within ~2–3× of
  AssemblyScript rather than the current order-of-magnitude gap).
- No correctness regression in `tests/issue-1530.test.ts` / `smoke-test.sh`.
