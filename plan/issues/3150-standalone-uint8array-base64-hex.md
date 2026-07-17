---
id: 3150
title: "standalone: Uint8Array.fromBase64 / fromHex (+ toBase64/toHex/setFrom*) (12 __get_builtin CEs)"
status: ready
sprint: current
priority: medium
horizon: m
feasibility: medium
area: codegen, runtime
goal: standalone-mode
related: [2984]
origin: "#2984 __get_builtin cluster triage (fable-sub1, 2026-07-11)"
---

# #3150 — standalone Uint8Array base64/hex codec statics

## Progress (2026-07-17, opus-a) — `fromHex` slice landed

The **`Uint8Array.fromHex(string)`** static factory is now implemented
standalone-native (`src/codegen/uint8-codec.ts` + a dispatch arm in
`src/codegen/expressions/call-builtin-static.ts`). It decodes the hex string
over its UTF-16 code units into the packed-`i8` Uint8Array vec (the same backing
`new Uint8Array` / `Uint8Array.of` produce), throwing the spec's `SyntaxError`
on odd length / illegal characters (whitespace is NOT skipped for hex). Only a
**string-typed** argument routes here — per spec `fromHex` throws a `TypeError`
without ToString coercion for a non-string, so a non-string arg falls through to
the existing refusal (no silent wrong coercion, no regression). Gated on
`noJsHost` (host lane unaffected). Covered by `tests/issue-3150.test.ts`.
This clears the `fromHex/{illegal-characters,odd-length-input}` + core-decode
`__get_builtin` CEs.

**Remaining (this issue stays open):**
- `Uint8Array.fromBase64` (default alphabet + padding; then the `alphabet` /
  `lastChunkHandling` options, whitespace, `last-chunk-*` fidelity).
- Instance methods `toHex` / `toBase64` / `setFromHex` / `setFromBase64`
  (currently silently return `null`).
- **Static return-type branding** so `results.js`'s
  `Object.getPrototypeOf(arr) === Uint8Array.prototype` / `arr.buffer` assertions
  pass — the checker doesn't know `fromHex` returns `Uint8Array` (not in the TS
  lib), so the result is statically `any` and `instanceof`/prototype checks miss
  even though the runtime bytes are correct. Fix: teach the checker/type-mapper
  (or a bundled `.d.ts`) that `Uint8Array.fromHex`/`fromBase64` return
  `Uint8Array`.

## Problem

The ES2025 `Uint8Array.fromBase64` / `Uint8Array.fromHex` statics (and the
sibling instance methods `toBase64`/`toHex`/`setFromBase64`/`setFromHex`) used
standalone hard-CE through the `__get_builtin` dynamic-shape refusal (#1472
Phase B). Measured **12** non-pass standalone entries under
`built-ins/Uint8Array/{fromBase64,fromHex}/` (the static-factory subset; sweep
the instance methods too when sizing).

## Sample paths

- `test/built-ins/Uint8Array/fromHex/illegal-characters.js`
- `test/built-ins/Uint8Array/fromHex/odd-length-input.js`
- `test/built-ins/Uint8Array/fromHex/string-coercion.js`
- `test/built-ins/Uint8Array/fromBase64/illegal-characters.js`

## Shared-infra deps

- Needs `Uint8Array.fromBase64`/`fromHex` as resolvable standalone statics with
  a native base64/hex decoder writing into a fresh Uint8Array (linear or
  WasmGC typed array backing). The error-path tests (illegal chars, odd
  length) mostly assert `SyntaxError`/`TypeError` on malformed input +
  string-coercion of the arg — the decoder itself is a self-contained byte
  loop, no cross-cutting substrate. Reuses the existing TypedArray backing.

## Acceptance

- `built-ins/Uint8Array/{fromBase64,fromHex}/*` standalone tests compile + pass
  with 0 regressions; extend to `toBase64`/`toHex`/`setFrom*` if they cluster.
