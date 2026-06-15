---
id: 2166
title: "Standalone JSON conformance residual (~76 tests)"
status: ready
sprint: 62
created: 2026-06-15
updated: 2026-06-15
priority: low
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: standalone
language_feature: json
goal: standalone-mode
parent: 1599
---

# Standalone JSON conformance residual

## Problem

The standalone JSON parser/stringifier landed in #1599 (`done`, sprint 58).
The host-vs-standalone baseline diff (sha `31fa7e099`, 2026-06-15) shows
**76 tests pass in host mode but fail standalone**, attributed to JSON
parse/stringify residuals — currently **untracked**.

## Evidence

- Gap category: `built-ins/JSON` 76; mix of runtime `fail` (reviver/replacer
  behavior, number formatting) and a few compile errors.

## Acceptance criteria

- Standalone pass count for `built-ins/JSON` rises toward host parity.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1599. Part of sprint-62 standalone catch-up (rank 12 by gap
impact). Likely benefits from the coercion engine (#1917) number/string path.

---

## Progress (2026-06-15, dev3) — boolean-typed `JSON.stringify` slice

**Status stays `ready`** — this is one slice of the 76-test bucket, not the
whole residual.

Investigation against `origin/main` @ `516feec44` found the standalone
`JSON.stringify` primitive/static-fold slices (#1324 / #1599) are in much
better shape than the gap suggests; verified working in standalone (compared
INTERNALLY, since standalone native strings don't marshal across the JS export
boundary):

- `JSON.stringify` of **static** object/array/number/string/nested literals →
  correct (folded by `tryEmitJsonStringifyStatic`).
- `JSON.stringify` of a **dynamic** number / string → correct.
- `JSON.parse` of a runtime number/`true`/`false`/`null` string → correct.

**One concrete bug fixed (this PR):** `JSON.stringify` of a **`boolean`-typed**
value (`const b: boolean = …`) refused to compile in standalone. TypeScript
models `boolean` as the union `true | false`, so the value carries the `Union`
type flag and was wrongly rejected by the ambiguous-shape early-return in
`tryEmitJsonStringifyPrimitive` (`src/codegen/expressions/calls.ts`) before
reaching the boolean stringify branch. The fix recognizes the `boolean` union
(`Boolean` flag + `intrinsicName === "boolean"`) ahead of the mask. Static
`true`/`false` literals were unaffected and keep working; a genuinely mixed
union (`boolean | number`) still falls through to the host import (intrinsicName
guard). Regression test: `tests/issue-2166.test.ts` (8 cases, host + standalone).

**Still open (the bulk of the 76):** `JSON.stringify` / `JSON.parse` of
**dynamic object graphs** (runtime-built objects, runtime JSON text →
object/array) still refuse with the #1599 Phase-2 compile error — they need the
pure-Wasm JSON codec + a dynamic value representation. That is the #1599 Phase 2
architect-spec follow-up (large; benefits from the #1917 coercion engine and the
value-rep work), not a point fix.
