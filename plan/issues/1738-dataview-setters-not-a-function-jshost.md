---
id: 1738
title: "DataView.prototype.set* (setUint8 etc.) 'not a function' in JS-host mode"
status: backlog
created: 2026-05-29
updated: 2026-05-29
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: dataview
goal: test262-conformance
sprint: Backlog
related: [1717, 1654, 1700]
---
# #1738 — DataView setters are 'not a function' in JS-host mode

## Problem

In JS-host mode, calling a `DataView` setter throws
`setUint8 is not a function`:

```ts
var ab = new ArrayBuffer(4);
var dv = new DataView(ab);
dv.setUint8(0, 66);   // TypeError: setUint8 is not a function
```

`emitDataViewAccessor` / `isDataViewAccessor` (`src/codegen/dataview-native.ts`,
added in #1654) implement the get/set accessors Wasm-natively, but in JS-host
mode the set path is not routed (the get path / native path is gated on
`noJsHost`, mirroring the #1698/#1717 slice gap). The `DataView` setters
should route through the same native `i32_byte` byte read/write in both modes,
since the backing store is identical.

## Root-cause hypothesis

The DataView accessor dispatch in `src/codegen/expressions/calls.ts` likely
gates the native emitter on `noJsHost(ctx)` (same pattern as the pre-#1717
slice guard). Removing the guard for the byte read/write (the store is
mode-agnostic) should make `set*`/`get*` callable in JS-host mode.

## Acceptance criteria

- `dv.setUint8(i, v)` / `dv.getUint8(i)` work in JS-host mode.
- Multi-byte accessors honour `littleEndian`.
- No regression in standalone DataView tests.

## Source

Filed from #1717 implementation findings, 2026-05-29.
