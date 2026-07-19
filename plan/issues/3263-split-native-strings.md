---
id: 3263
title: "Split TextEncoder/TextDecoder helpers out of native-strings.ts god-file"
status: done
completed: 2026-07-14
sprint: 72
priority: high
feasibility: medium
model: opus
task_type: refactor
subtask_of: 3182
assignee: ttraenkler/sendev-split
area: codegen
---

# Split TextEncoder/TextDecoder helpers out of native-strings.ts

## Scope

Behaviour-preserving god-file split of `src/codegen/native-strings.ts` (~7,461 LOC).
Extract the self-contained TextEncoder/TextDecoder UTF-8 encode/decode runtime
subsystem — the functions `ensureEncodeIntoResultStruct` (private helper) and
`ensureTextEncodingHelpers` (public, ~642 LOC, formerly lines 5060–5708) — verbatim
into a NEW sibling module `src/codegen/text-encoding-native.ts`.

This is a pure move: NO logic changes. The new module exports
`ensureTextEncodingHelpers` and imports its dependencies (`ensureNativeStringHelpers`
from `./native-strings.js`; type/registry/func-space helpers with unchanged paths
since it is a sibling). `ensureEncodeIntoResultStruct` is used ONLY by
`ensureTextEncodingHelpers`, so both move together with no dangling reference.

The god-function `ensureNativeStringHelpers` does NOT call either moved function, so
there is no back-dependency and `native-strings.ts` imports nothing back — no import
cycle. The single external caller (`src/codegen/expressions/calls.ts`, 2 call sites)
is re-pointed to `../text-encoding-native.js` (one import-line edit).

## Acceptance

- `npx tsc --noEmit` → 0 errors.
- `npx tsx scripts/prove-emit-identity.mjs check` → IDENTICAL (byte-identity across
  gc / standalone / wasi). This is the behaviour gate: any drift means the move
  changed behaviour.
- Relocation-shift ratchets (loc-budget / oracle-ratchet / coercion-sites /
  dead-exports / verdict-oracle-bump) pass locally with the sanctioned per-issue
  frontmatter allowances (documented below), never a whole-tree baseline edit.

## Result

Pure verbatim move — DONE.

- `src/codegen/native-strings.ts`: 7,461 → 6,811 LOC (−650).
- `src/codegen/text-encoding-native.ts`: NEW, 668 LOC (18-line header/imports +
  649-line verbatim block).
- `src/codegen/expressions/calls.ts`: re-pointed the single external import of
  `ensureTextEncodingHelpers` to `../text-encoding-native.js` (one import line).
  `native-strings.ts` imports nothing back → no import cycle.
- `ensureEncodeIntoResultStruct` stays private in the new module (used only by
  `ensureTextEncodingHelpers`).

### Acceptance — all green

- `npx tsc --noEmit` → **0 errors**.
- `npx tsx scripts/prove-emit-identity.mjs check` → **IDENTICAL** (39/39
  file,target emits across gc / standalone / wasi).
- **No relocation-shift allowances were required** — the move is fully conserved,
  so every ratchet passed unchanged:
  - `check-loc-budget` OK (net +18 LOC, change-scoped vs merge-base)
  - `check-oracle-ratchet` OK (no checker-call-site growth; the moved code uses
    no `ctx.checker` / `getTypeAtLocation`)
  - `check-coercion-sites` OK (no coercion-vocabulary relocation)
  - `check-dead-exports` OK (0 new; `ensureTextEncodingHelpers` still imported)
  - `check-verdict-oracle-bump` OK (no verdict-logic files touched)
  - `check:godfiles`, `check:any-box-sites`, `check:stack-balance` OK
- Smoke test `tests/issue-3263.test.ts` (4 cases, standalone + wasi) green:
  compiles `TextEncoder.encode`/`TextDecoder.decode` (emits the relocated
  `__textencoder_encode` / `__textdecoder_decode_u8` helpers, native path, valid
  module) and `TextEncoder.encodeInto` (result-struct member resolves via
  `struct.get`, no `env.__extern_get` host import — #1780 acceptance).

Runtime numeric output for this subsystem is covered by `tests/issue-1780.test.ts`;
that suite fails IDENTICALLY on the clean origin/main base in this container (a
pre-existing local WasmGC-execution limitation, unrelated to the move — consistent
with byte-identity IDENTICAL), so the #3263 smoke test asserts at the compile/emit
level to stay deterministic locally and in CI.
