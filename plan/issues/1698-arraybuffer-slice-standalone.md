---
id: 1698
title: "ArrayBuffer.prototype.slice() not implemented in --target wasi (dual-mode gap, same shape as #1654)"
status: done
created: 2026-05-28
updated: 2026-05-28
completed: 2026-05-28
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: wasi, codegen
language_feature: arraybuffer
goal: wasi-completeness
sprint: Backlog
related: [1654, 1530, 1595]
---
## Problem

Under `--target wasi`, `ArrayBuffer.prototype.slice(begin, end)` **compiles**
but **traps at runtime with `illegal cast`**. The slice() call is silently
dropped: the arguments are evaluated and discarded, and the receiver is
replaced with `ref.null extern` — so the next operation that recovers the
backing `i32_byte` vec struct (e.g. `new Uint8Array(sliced)`) traps.

Same dual-mode gap as #1654 (DataView accessors / ArrayBuffer-backed
TypedArrays): the JS host implements `slice` natively, but standalone /
WASI mode has no JS runtime and no Wasm-native path either, so the call
falls through and emits a no-op.

## Minimal repro (verified)

```ts
declare const process: { stdout: { write(c: Uint8Array): void } };
export function main(): void {
  const ab = new ArrayBuffer(4);
  const dv = new DataView(ab);
  dv.setUint8(0, 0x41);
  dv.setUint8(1, 0x42);
  dv.setUint8(2, 0x43);
  dv.setUint8(3, 0x44);
  const sliced = ab.slice(1, 3);
  process.stdout.write(new Uint8Array(sliced));
}
```

Compile with `npx tsx src/cli.ts repro.ts --target wasi -o out`, then
instantiate the resulting module. The `new WebAssembly.Module(binary)` step
succeeds (valid module) but `inst.exports.main()` throws `RuntimeError:
illegal cast`. The WAT shows the slice() call lowering to:

```
f64.const 1
drop
f64.const 3
drop
ref.null extern
local.set $sliced
```

— args evaluated for side effects and discarded; result is `null`.

## Root cause

In `src/codegen/expressions/calls.ts`, ArrayBuffer is declared in lib.d.ts so
`isExternalDeclaredClass(receiverType, ...)` returns true. The extern-class
dispatch tries to resolve `ArrayBuffer_slice` as a host import; under
`--target wasi` (`noJsHost(ctx) === true`) no such host import exists, so the
call falls through to a degraded path that drops args and returns `null`.

There is no Wasm-native `slice` implementation analogous to the
`emitDataViewAccessor` in `src/codegen/dataview-native.ts` from #1654.

## Acceptance criteria

- `ab.slice(begin, end)` returns a new ArrayBuffer of length
  `min(end, ab.byteLength) - max(begin, 0)`, containing the bytes from
  `[begin, end)`, under `--target wasi` and `--target standalone`.
- Negative `begin`/`end` arguments resolve via spec §25.1.5.3
  (negative = length + arg, clamped to [0, length]).
- Omitted `end` defaults to `ab.byteLength` (full tail).
- The resulting buffer is independent — mutating the source after slice
  does not affect the slice.
- `new Uint8Array(sliced)` views the slice's bytes.
- A unit test (`tests/issue-1698.test.ts`) pins basic slice, OOB slice,
  negative-offset slice, and the "independent buffer" property.
- No regression in the existing #1654 ArrayBuffer/DataView WASI tests
  (`tests/issue-1654-wasi-dataview-arraybuffer.test.ts`).

## Implementation plan

Mirror the #1654 dual-mode pattern in `src/codegen/dataview-native.ts`:

1. Add `emitArrayBufferSlice(ctx, fctx, receiver, args, compileExpr)` that:
   - Recovers the source `i32_byte` vec struct from the receiver (externref
     → `any.convert_extern` → `ref.cast`).
   - Computes `srcLen`, normalizes `begin` and `end` per spec
     (negative = len + arg; clamp to `[0, len]`; missing end = len).
   - Computes `sliceLen = max(end - begin, 0)`.
   - Allocates a new `i32_byte` array of `sliceLen`, copies bytes
     `src[begin .. begin+sliceLen)` byte-by-byte (`array.get` →
     `array.set`).
   - Constructs and returns the new `i32_byte` vec struct, returning it as
     `externref` via `extern.convert_any` so it slots into the
     externref-typed `sliced` local that user code declares.
2. Hook it into `calls.ts` just below the DataView accessor block — gated
   on `noJsHost(ctx) && receiverSym === "ArrayBuffer" && propAccess.name.text === "slice"`.
3. Out of scope: `SharedArrayBuffer.slice` (not yet supported in standalone),
   `TypedArray.prototype.slice` (separate buffer model, tracked elsewhere),
   `transferable` semantics (#1595 covers transfer).
