---
id: 1780
title: "TextEncoder.encodeInto support for standalone and WASI"
status: done
created: 2026-06-02
updated: 2026-06-03
completed: 2026-06-03
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: runtime
language_feature: web-api
goal: platform
sprint: Backlog
related: [389, 1588, 1655, 1752]
origin: "Follow-up to #1752 stretch goal: TextEncoder.encodeInto was explicitly not implemented."
---
# #1780 - TextEncoder.encodeInto support for standalone and WASI

## Problem

#1752 added Wasm-native `TextEncoder.encode` and `TextDecoder.decode` for
standalone/WASI no-host mode, closing the native-messaging UTF-8 runtime API
gap from GitHub #389. The stretch API `TextEncoder.prototype.encodeInto` was
left unimplemented.

`encodeInto(input, destination)` should write UTF-8 bytes into the supplied
`Uint8Array` and return `{ read, written }`, respecting partial writes and
never splitting a code point or surrogate pair.

## Acceptance

- `new TextEncoder().encodeInto(str, dest)` exists and returns an object with
  standard `{ read, written }` fields.
- The API works under standalone/WASI no-host targets without adding
  `TextEncoder_*` host imports.
- ASCII, multibyte BMP code points, surrogate pairs, lone surrogates, empty
  strings, and too-small destination buffers are covered by tests.
- Partial writes report exact `read` and `written` counts and leave the
  remaining destination bytes untouched.
- Existing #1752 encode/decode round-trip tests continue to pass.

## Non-goals

- Streaming decode support.
- Encoding labels beyond UTF-8.
- Replacing or redesigning the existing `TextEncoder.encode` lowering.

## Implementation (2026-06-03)

Lowered `TextEncoder.prototype.encodeInto(source, dest)` Wasm-native for
standalone/WASI no-host targets — no `TextEncoder_*` host imports.

- `src/codegen/native-strings.ts`: `ensureEncodeIntoResultStruct` registers a
  `TextEncoderEncodeIntoResult` WasmGC struct (`{read: f64, written: f64}`).
  `ensureEncodeIntoHelper(ctx, destElemKey)` emits the surrogate-aware UTF-8
  bounded-write helper returning multi-value `(i32 read, i32 written)`. The
  helper never splits a code point across the destination boundary and folds
  lone surrogates to U+FFFD. Dest element type is parameterised: `i8_byte`
  (packed) for standalone/WASI `Uint8Array`, `f64` otherwise.
- `src/codegen/expressions/calls.ts`: `encodeInto` call-site dispatch in the
  no-host `TextEncoder` block. The result struct is materialised at the call
  site (`struct.new` in a normally-compiled function) — emitting `struct.new`
  from inside the late-registered helper body lands on a wrong type index after
  dead-elimination remap.
- `src/codegen/property-access.ts`: `.read`/`.written` fast path. **Root cause
  of the WASI `__vec_get` "expected externref, found array.get of type f64"
  invalid-Wasm**: the receiver call registers the result struct lazily, so the
  struct type index is only known *after* the receiver is compiled. The old
  code looked up the struct index before compiling the receiver, found
  `undefined`, and fell through to the generic `__extern_get` member-read path.
  That added an `env.__extern_get` import *late*, shifting `numImportFuncs` and
  leaving `__box_number`'s `funcMap` index stale; `__vec_get` then emitted
  `call <__box_boolean>` (i32) fed an f64 array element. Fix: compile the
  receiver first, then read the now-registered struct index and emit a static
  `struct.get`, so no late host import is added and no index drift occurs.

## Test Results

`tests/issue-1780.test.ts` — 10/10 pass (5 scenarios × standalone + WASI):
ASCII read/written/bytes, multibyte BMP + surrogate pairs, lone surrogate →
U+FFFD, empty string, too-small buffer. No `TextEncoder_*` or `env.__extern_get`
imports in any output. Regression-checked: `tests/wasi.test.ts`,
`tests/wasi-target.test.ts`, `tests/native-strings-standalone.test.ts`,
`tests/issue-1654-wasi-dataview-arraybuffer.test.ts`,
`tests/issue-1655-wasi-arraybuffer-write.test.ts` — 52/52 pass.
