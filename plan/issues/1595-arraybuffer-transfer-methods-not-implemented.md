---
id: 1595
title: "ArrayBuffer.prototype.transfer / transferToFixedLength / transferToImmutable not implemented (~40 fails)"
status: blocked
created: 2026-05-24
updated: 2026-05-24
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: codegen
language_feature: ArrayBuffer, TypedArray
goal: spec-completeness
sprint: Backlog
test262_fail: 40
test262_category: built-ins/ArrayBuffer
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

## Investigation (2026-05-27, dev-1603) — ESCALATED, needs architect spec

The dispatch note in the issue ("delegate to host transfer like resize()") does
not hold against current main. There is **no host-backed ArrayBuffer and no
`resize` implementation** to mimic:

- `new ArrayBuffer(n)` compiles to a bare WasmGC vec struct `{ length: i32,
  data: array(i32) }` (`src/codegen/expressions/new-super.ts:2445-2495`). No
  detach flag, no resizable flag, no `maxByteLength` field.
- A repo-wide grep for `maxByteLength`, `resizable`, `detached`, `isDetached`,
  `.resize` in `src/` returns **zero** implementation hits — only an unrelated
  comment. So `resize`, `resizable`, `maxByteLength`, and `detached` are all
  unimplemented, not just `transfer`.

The transfer test262 cases require detach semantics that the current
representation cannot express. e.g.
`transfer/from-fixed-to-same.js` asserts after `source.transfer()`:
`source.byteLength === 0`, `source.slice()` **throws TypeError**,
`dest.resizable === false`, `dest.maxByteLength === 4`. Detaching must make
**every** subsequent op on the source (byteLength, slice, TypedArray view
reads, DataView reads) observe the detached state and throw.

### Why this is an architect-spec escalation (not a localized dev fix)

Implementing transfer correctly requires a **representation contract change** to
the shared ArrayBuffer struct (add a `detached`/state field, and for resizable
interop a `maxByteLength` field), which is read across:

- `src/codegen/expressions/new-super.ts` — ArrayBuffer/DataView/TypedArray construction
- `src/codegen/property-access.ts` — `.byteLength` / vec-struct field access (the
  `isVecStructAccess` check at ~line 3026 keys off exactly `{length,data[,raw]}`;
  adding fields changes this contract)
- `src/codegen/array-methods.ts` — `.slice`, `.subarray`, TypedArray ops
- `src/codegen/dataview-native.ts` — DataView get/set must check detached

Every reader of the vec struct would need a detached-guard, and the
`isVecStructAccess` shape predicate would have to be widened without breaking
plain Array/TypedArray vec structs. This is a cross-cutting design decision
about how detach state is represented and threaded — exactly what an architect
spec should settle before a dev implements.

### Recommended sequencing

1. Architect spec: ArrayBuffer detach-state representation + resizable/maxByteLength
   model (prereq, likely overlaps #1351 resizable-ArrayBuffer).
2. Dev: implement `detached` + `resize`/`resizable`/`maxByteLength` on the new
   representation.
3. Dev: implement `transfer` / `transferToFixedLength` (copy + detach source).
4. Dev: `transferToImmutable` (immutable flag; write ops throw).

Marking `status: blocked` pending architect spec. No code changed; worktree
`issue-1595-arraybuffer-transfer` left in place (only this doc edit committed).
