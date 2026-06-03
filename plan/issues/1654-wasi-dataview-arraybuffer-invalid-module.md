---
id: 1654
title: "wasi: DataView/ArrayBuffer-backed TypedArrays emit an invalid wasm module under --target wasi"
status: done
created: 2026-05-24
updated: 2026-05-24
completed: 2026-05-24
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: wasi, codegen
language_feature: arraybuffer, dataview, typedarray
goal: wasi-completeness
sprint: Backlog
required_by: [1530, 1653, 1655]
related: [1530, 1651, 1653]
---
## Problem

Under `--target wasi`, code using `new ArrayBuffer(n)` +
`DataView.setUint32/getUint32(…, true)` + `new Uint8Array(arrayBuffer)`
**COMPILES** but produces an **INVALID module**. wasmtime rejects it at
instantiation/compile time:

```
Error: failed to compile: wasm[0]::function[N]::main
  Invalid input WebAssembly code: unknown global: global index out of bounds
```

## Minimal repro (verified)

Compile with `npx tsx src/cli.ts repro.ts --target wasi -o out`, then run the
emitted module under wasmtime:

```ts
declare const process: { stdout: { write(c: Uint8Array): void } };
export function main(): void {
  const header = new ArrayBuffer(4);
  const dv = new DataView(header);
  dv.setUint32(0, 11, true);
  process.stdout.write(new Uint8Array(header));
}
```

The compile step succeeds; wasmtime rejects the resulting binary with the
`unknown global: global index out of bounds` error above.

## Likely cause

The ArrayBuffer/DataView/TypedArray codegen references a heap or memory
global that is only emitted in **JS-host mode**, not in **standalone/WASI
mode**. This is the dual-mode gap described under "Architecture Principles"
in `CLAUDE.md`: features need a Wasm-native implementation for standalone
mode, but the ArrayBuffer/DataView path appears to assume the JS-host heap
global is always present.

This is **broader than the Native Messaging example**: any binary-buffer
code (ArrayBuffer / DataView / ArrayBuffer-backed TypedArray) is affected
under `--target wasi`.

## Contrast — what does work

`new Uint8Array([b0, b1, b2, b3])` (the literal-array constructor form,
delivered in #1651) **DOES work** under `--target wasi`. Only the
**ArrayBuffer/DataView-backed** path is broken. So the regression surface is
specifically the ArrayBuffer-backing global, not TypedArrays in general.

## Acceptance criteria

- The minimal repro above compiles AND the emitted module is accepted by
  wasmtime (no `unknown global` error).
- `DataView.setUint32(0, v, true)` / `getUint32(0, true)` round-trip correctly
  under wasmtime in standalone/WASI mode.
- `new Uint8Array(arrayBuffer)` produces a view whose bytes match what was
  written through the `DataView`.
- A test (e.g. `tests/issue-1654-*.test.ts`) pins compile + WASI-module
  validity + a byte round-trip for the ArrayBuffer/DataView path.
- No regression to the literal-array `new Uint8Array([...])` path (#1651).

## Implementation notes (resolution)

The `unknown global` was only the surface symptom. Root-causing it exposed
**three** distinct dual-mode gaps; all three were the same underlying problem
(ArrayBuffer/DataView/TypedArray codegen assumed the JS host, with no
standalone Wasm-native path):

1. **Invalid module (`global.get -1`)** — the ArrayBuffer/DataView/Array
   RangeError validation paths in `src/codegen/expressions/new-super.ts`
   emitted `global.get strIdx` where `strIdx` came from
   `ctx.stringGlobalMap.get(msg)`. In `nativeStrings` mode (auto-enabled for
   `--target wasi`), `addStringConstantGlobal` stores the sentinel `-1` because
   strings are materialised *inline*, not via an imported global — so the
   throw branch emitted `global.get -1`, an out-of-range global. Fixed by
   routing all eight RangeError throw sites through
   `stringConstantExternrefInstrs(ctx, msg)` (native-strings.ts), which already
   handles both modes (inline NativeString → `extern.convert_any` in WASI,
   `global.get` in JS-host).

2. **`dv.setUint32(...)` was a silent no-op** — DataView accessors had no
   standalone implementation; only the JS runtime (`runtime.ts`) implemented
   them via the `__dv_byte_{get,set}` exports + a real native `DataView`. In
   no-JS-host mode the method call fell through and its args were compiled and
   dropped, writing nothing. Fixed with a new module
   `src/codegen/dataview-native.ts` (`emitDataViewAccessor`) that emits
   Wasm-native byte read/write directly into the `i32_byte` vec backing array
   (field 0 = len, field 1 = byte array). Honours the `littleEndian` flag at
   runtime; covers get/set {Uint,Int}{8,16,32}, getFloat/setFloat{32,64}.
   Hooked into `calls.ts` *before* the extern-class dispatch, gated on
   `noJsHost(ctx) && receiver is DataView`.

3. **`new Uint8Array(arrayBuffer)` created an empty array** — the TypedArray
   constructor treated *any* single arg as a numeric length, so an ArrayBuffer
   arg was coerced f64 (→ 0) and the bytes were never copied. Fixed by
   detecting an ArrayBuffer/DataView/SharedArrayBuffer arg
   (`emitTypedArrayFromByteBuffer` in new-super.ts) and copying the `i32_byte`
   backing bytes into the TypedArray's f64-element vec (the representation
   `process.stdout.write` consumes).

**New Wasm opcodes**: `i32.reinterpret_f32` (0xBC) and `f32.reinterpret_i32`
(0xBE) were added to the `Instr` union, both encoders (binary.ts/object.ts),
and the stack-balance unary group — needed for Float32 DataView accessors.

**Verified under real wasmtime** (`-W gc=y,function-references=y,tail-call=y,
exceptions=y`): the repro emits exactly `0b 00 00 00`; a mixed LE/BE/8/16/32
get+set round-trip produced the expected byte pattern. Committed test
`tests/issue-1654-wasi-dataview-arraybuffer.test.ts` pins the same via the
CI-portable raw-byte WASI shim. No regression: the pre-existing JS-host
DataView suites (#1056, #1064, #1515) and the literal-array path (#1651) all
still pass; the `string_constants`-import failures in `typed-array-basic` /
`arraybuffer-dataview` are a pre-existing test-harness gap (identical
pass/fail counts before and after this change).
