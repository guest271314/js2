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
