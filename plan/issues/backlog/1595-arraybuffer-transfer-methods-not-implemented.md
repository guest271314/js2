---
id: 1595
title: "ArrayBuffer.prototype.transfer / transferToFixedLength / transferToImmutable not implemented (~40 fails)"
status: backlog
created: 2026-05-24
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: ArrayBuffer, TypedArray
goal: spec-completeness
test262_fail: 40
test262_category: built-ins/ArrayBuffer
depends_on: []
---

# #1595 — ArrayBuffer.prototype.transfer / transferToFixedLength / transferToImmutable

## Problem

**~40 test262 failures** because three ES2024 ArrayBuffer methods are not implemented:

| Method | Fails | Error |
|--------|-------|-------|
| `ArrayBuffer.prototype.transfer` | ~12 | `transfer is not a function` |
| `ArrayBuffer.prototype.transferToFixedLength` | ~12 | `transferToFixedLength is not a function` |
| `ArrayBuffer.prototype.transferToImmutable` | ~14 | `transferToImmutable is not a function` |

Additionally ~2 tests test spec-level behavior (errors on incorrect arguments) so the total +PASS from implementation may be ~38.

### Sample failures

```
test/built-ins/ArrayBuffer/prototype/transfer/from-resizable-to-zero.js
  L65:3 transfer is not a function

test/built-ins/ArrayBuffer/prototype/transferToFixedLength/from-fixed-to-same.js
  L65:3 transferToFixedLength is not a function

test/built-ins/DataView/prototype/setInt16/immutable-buffer.js
  L...: transferToImmutable is not a function
```

## Spec

- `ArrayBuffer.prototype.transfer([newByteLength])` — §25.1.5.4: detaches the source buffer and returns a new ArrayBuffer with the same (or resized) backing store
- `ArrayBuffer.prototype.transferToFixedLength([newByteLength])` — §25.1.5.5: same, but result is always a fixed-length buffer
- `ArrayBuffer.prototype.transferToImmutable()` — Stage 3 / ES2025 proposal: returns an immutable (non-detachable, non-resizable) copy of the buffer

## Acceptance criteria

- `transfer` and `transferToFixedLength` fully implemented per ES2024 spec
- `transferToImmutable` implemented as best-effort (mark buffer as immutable; reject write operations)
- All ~40 test262 files pass
- Existing TypedArray / DataView / ArrayBuffer tests continue to pass

## Notes

- Check whether #1351 (resizable ArrayBuffer) overlaps — `transfer` interacts with resizable buffers
- Our runtime has `ArrayBuffer` host interop via `src/runtime.ts`; the new methods likely need to be added there and exported
- `transferToImmutable` is the only one that creates a new semantics concept (immutable buffers). May need a flag in the host wrapper.
