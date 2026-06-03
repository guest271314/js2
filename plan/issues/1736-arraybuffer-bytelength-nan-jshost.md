---
id: 1736
title: "ArrayBuffer.prototype.byteLength returns NaN in JS-host mode"
status: backlog
created: 2026-05-29
updated: 2026-05-29
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: arraybuffer
goal: test262-conformance
sprint: Backlog
related: [1717, 1700, 1350]
---
# #1736 — ArrayBuffer byteLength returns NaN in JS-host mode

## Problem

In JS-host mode, reading `.byteLength` on an `ArrayBuffer` returns `NaN`
instead of the buffer's byte length:

```ts
var ab = new ArrayBuffer(8);
ab.byteLength;        // expected 8, actual NaN
```

Observed while implementing #1717 (`ArrayBuffer.prototype.slice`): every
`built-ins/ArrayBuffer/prototype/slice/*` test262 case asserts
`result.byteLength`, so even with `slice` now callable (#1717), the
assertions cannot flip until `byteLength` resolves.

`ArrayBuffer` is backed by an `i32_byte` vec struct (field 0 = length i32).
The `byteLength` getter must read that length field (and divide-by-nothing —
it's 1 byte per element). In JS-host mode the property read currently does
not resolve to the vec length-field read and produces NaN.

## Reproduction

Faithful harness (`buildImports` + `getTestSandbox`) and a minimal probe both
return NaN for `new ArrayBuffer(8).byteLength`, on clean main as well — so
this is independent of #1717's slice change.

## Root-cause hypothesis

`byteLength` is not specifically lowered in `src/codegen/property-access.ts`
for ArrayBuffer-typed receivers; it falls through to a generic property read
that yields NaN. It should emit `struct.get` of the vec length field (field 0)
for `i32_byte`-backed ArrayBuffer / DataView receivers.

## Acceptance criteria

- `new ArrayBuffer(n).byteLength === n` in JS-host mode.
- Unblocks the #1717 slice assertions (`result.byteLength`).
- No regression in TypedArray / DataView byteLength.

## Source

Filed from #1717 implementation findings, 2026-05-29.
