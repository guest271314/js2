---
id: 1654
title: "wasi: DataView/ArrayBuffer-backed TypedArrays emit an invalid wasm module under --target wasi"
status: backlog
created: 2026-05-24
updated: 2026-05-24
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: wasi, codegen
language_feature: arraybuffer, dataview, typedarray
goal: wasi-completeness
sprint: Backlog
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
