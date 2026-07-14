---
id: 3263
title: "Split TextEncoder/TextDecoder helpers out of native-strings.ts god-file"
status: ready
sprint: current
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
