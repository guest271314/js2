---
id: 3150
title: "standalone: Uint8Array.fromBase64 / fromHex (+ toBase64/toHex/setFrom*) (12 __get_builtin CEs)"
status: done
completed: 2026-07-17
sprint: 72
priority: medium
horizon: m
feasibility: medium
area: codegen, runtime
goal: standalone-mode
related: [2984]
origin: "#2984 __get_builtin cluster triage (fable-sub1, 2026-07-11)"
loc-budget-allow:
  - src/codegen/expressions/call-builtin-static.ts
  - src/codegen/uint8-codec.ts
  - src/codegen/expressions/call-receiver-method.ts
---

# #3150 — standalone Uint8Array base64/hex codec statics

## Progress (2026-07-17, dev-j) — `toHex` / `toBase64` instance methods landed

The **`Uint8Array.prototype.toHex()`** and **`Uint8Array.prototype.toBase64()`**
instance methods are now implemented standalone-native (`__uint8_to_hex` /
`__uint8_to_base64` + the `__hex_char` / `__base64_char` alphabet-encode helpers
in `src/codegen/uint8-codec.ts`, plus a dispatch arm in the standalone
native-string block of `src/codegen/expressions/call-receiver-method.ts`
alongside the TextEncoder/TextDecoder lowering). They read the packed-`i8`
Uint8Array vec (the same backing `new Uint8Array` / `Uint8Array.of` / `fromHex`
produce) and build a fresh i16-backed native string:
- `toHex` emits two LOWERCASE hex code units per byte.
- `toBase64` emits standard-alphabet base64 under the DEFAULT options
  (`alphabet: "base64"`, `omitPadding: false`): 3-byte groups → 4 chars, a
  trailing 1-/2-byte chunk emits partial sextets + `=` padding to a full group,
  and the `+` / `/` sextets (62/63) are covered.

Only the **no-argument** form routes here — a `.toBase64({...})` call carrying an
options object has `arguments.length > 0` and falls through to the existing
dynamic-shape refusal, so no wrong default (base64url / omitPadding) is silently
applied. Gated on the standalone native-string path (host lane unaffected). 0
host imports. Covered by `tests/issue-3150.test.ts` (byte-exact via `.length` +
`.charCodeAt`).

**Known limitation carried forward** (same static return-type branding gap as
the statics): `toHex`/`toBase64` are not in the bundled TS lib, so the checker
types the result `any`; a direct `arr.toHex() === "literal"` uses the
`any === <literal>` reference-eq fast-path and mis-compares even though the
runtime string is byte-correct. test262's `assert.sameValue(actual, expected)`
(untyped params → content comparison) passes. The branding fix (teach the
checker/type-mapper these return `string`) is the same remaining item already
tracked below and applies to the statics too.

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

## Progress (2026-07-17, opus-a) — `fromBase64` slice landed

The **`Uint8Array.fromBase64(string)`** static factory is now also implemented
standalone-native (`__uint8_from_base64` + `__base64_digit` in
`src/codegen/uint8-codec.ts`, plus a dispatch arm in
`src/codegen/expressions/call-builtin-static.ts`). It decodes a
standard-alphabet base64 string under the **default options** (`alphabet:
"base64"`, `lastChunkHandling: "loose"`): 4-char groups → 3 bytes, ASCII
whitespace skipped, `=` padding validated, loose trailing 2-/3-char chunks
accepted (1/2 bytes), and the spec's `SyntaxError` on an illegal character, a
single trailing character, unexpected padding, or any character after padding.
Only a **bare string** argument routes here — a call carrying the options object
has `arguments.length > 1` and falls through to the existing dynamic-shape
refusal, so no wrong default is silently applied. Standalone-pure (0 host
imports). Covered by `tests/issue-3150.test.ts`.

**Remaining (this issue stays open):**
- `Uint8Array.fromBase64` **options object** — the `alphabet: "base64url"` and
  `lastChunkHandling: "strict" | "stop-before-partial"` variants (a call with a
  second argument still refuses; only the default-options string form is
  handled).
- Instance methods `toHex` / `toBase64` **landed** (dev-j, 2026-07-17, see
  progress note above). `setFromHex` / `setFromBase64` (in-place decode into an
  existing array) still silently return `null` — follow-up.
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
