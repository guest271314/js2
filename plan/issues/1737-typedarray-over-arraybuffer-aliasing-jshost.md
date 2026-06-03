---
id: 1737
title: "Uint8Array(arrayBuffer) does not alias the ArrayBuffer's backing store (JS-host)"
status: backlog
created: 2026-05-29
updated: 2026-05-29
priority: medium
feasibility: hard
task_type: bugfix
area: codegen
language_feature: typedarray
goal: test262-conformance
sprint: Backlog
related: [1717, 1700, 1350]
---
# #1737 — TypedArray view over ArrayBuffer does not alias the buffer (JS-host)

## Problem

`new Uint8Array(arrayBuffer)` should create a *view* sharing the
ArrayBuffer's backing store, so writes through the view are visible on the
buffer and vice-versa:

```ts
var ab = new ArrayBuffer(8);
var u = new Uint8Array(ab);
u[2] = 77;
ab.slice(2, 3);   // byte 0 of the slice should be 77 — actual: 0
```

Observed while implementing #1717. The slice byte-copy reads the
ArrayBuffer's `i32_byte` vec directly via Wasm `array.get`, but the
`Uint8Array` write never reached that store.

## Root-cause hypothesis

Per `src/codegen/dataview-native.ts`, `ArrayBuffer`/`DataView` are backed by
a vec of element type `i32_byte` (one i32 per byte), while the `Uint8Array`
write path uses a vec of element type `f64`. So `new Uint8Array(ab)` builds a
SEPARATE f64-backed vec instead of a view that shares `ab`'s `i32_byte`
store — the two are not aliased. A TypedArray constructed over an existing
ArrayBuffer must wrap (not copy) the buffer's backing array with an
offset/length view.

This is adjacent to #1700 (TypedArray export ABI) and #1350 (resizable /
detached buffers) — the unified ArrayBuffer/TypedArray representation likely
needs an architect pass.

## Acceptance criteria

- `new Uint8Array(ab)` shares `ab`'s backing store (writes alias both ways).
- `ab.slice(...)` reflects writes made through a TypedArray view.
- No regression in standalone TypedArray tests.

## Source

Filed from #1717 implementation findings, 2026-05-29.
