---
id: 1783
title: "IR inference parity: native-messaging .js and .ts emit divergent WASI Wasm"
status: ready
created: 2026-06-03
updated: 2026-06-03
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ir, type-inference, codegen
language_feature: allowJs, template-literals, numeric-inference
goal: backend-agnostic-ir
sprint: Backlog
related: [389, 1767, 1768, 1584]
---
# #1783 - IR inference parity: native-messaging `.js` and `.ts` emit divergent WASI Wasm

## Problem

The fixed native-messaging host now compiles and runs from both the TypeScript
source and a plain JavaScript source produced from it, but the emitted Wasm is
not equivalent.

Reproduction:

1. Transpile `examples/native-messaging/nm_js2wasm.ts` to JavaScript with
   TypeScript `transpileModule`, preserving ES modules.
2. Compile both inputs with `--target wasi`.
3. Compare the generated Wasm/WAT.

Observed on 2026-06-03:

```text
TS wasm:  9617 bytes
JS wasm:  8218 bytes

TS sha256: e45471155294cd795e2f8b9858115294ee3bb8e56eb96deef7f98cd67252d8d2
JS sha256: 6ec0c242545d98c5cc54c99f5057a2c02b4aa011d2cc97f0b2dc1b54688cf955

wasm_equal = false
wat_equal  = false
```

Both modules are clean WASI-only modules:

```wat
(import "wasi_snapshot_preview1" "fd_write" ...)
(import "wasi_snapshot_preview1" "fd_read" ...)
```

Neither module imports `env::*`.

## Difference

The TypeScript path keeps numeric annotations and lowers numeric values through
the known `number` path:

- `decodeLength(...) -> f64`
- `readFrameBody(param f64)`
- `sendMessage` local `len: f64`
- stderr template interpolation pulls in native number-to-string helpers:
  `__num_fmt_finalize`, `number_toString_radix`, and `number_toString`.

The JavaScript/`allowJs` path loses those annotations and widens some numeric
values through boxed `externref`:

- `decodeLength(...) -> externref`
- `readFrameBody(param externref)`
- `sendMessage` local `len: externref`
- extra `__box_number` / `__unbox_number` calls compensate for the widened
  values.
- numeric template literal interpolations in `logFrameBodyRead` are not
  equivalent: the JS WAT computes some numeric values and drops them, inserting
  empty strings for those interpolations instead of using the native
  number-to-string lowering.

The protocol behavior is correct because stdout framing uses byte writes, but
stderr diagnostics differ and the IR/codegen shape is unnecessarily divergent.

## Likely root cause

The `allowJs` path is not preserving or recovering enough numeric type
information for:

- return values from simple numeric helper functions such as `decodeLength`
- locals initialized from numeric expressions
- numeric template literal substitutions
- numeric arguments flowing into typed-array sizing / indexing helpers

This creates a mixed `externref`/`f64` IR where the TypeScript path emits a
direct numeric IR. The old invalid-Wasm bug in #1768 was fixed by removing dead
continuation helpers from the example, but the underlying inference parity gap
remains.

## Acceptance criteria

- Add a regression that compiles the native-messaging host from TypeScript and
  from equivalent plain JavaScript and compares the relevant IR/codegen shape.
- The JavaScript path should infer numeric values in the native-messaging host
  well enough that:
  - `decodeLength` returns a numeric representation, not boxed `externref`;
  - `readFrameBody` accepts the same numeric representation as the TS path;
  - `sendMessage` keeps `message.length` numeric without boxing;
  - numeric template literal substitutions in `logFrameBodyRead` produce the
    same stderr text as the TypeScript path.
- Both TS and JS outputs remain WASI-only with no `env::*` imports.
- Prefer improving shared IR inference / type propagation over adding
  native-messaging-specific special cases.

