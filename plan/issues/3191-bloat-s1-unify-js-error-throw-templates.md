---
id: 3191
title: "bloat S1: unify the 4 hand-rolled JS-error-throw templates on buildThrowJsErrorInstrs"
status: done
completed: 2026-07-12
assignee: ttraenkler/dev-number-resid
created: 2026-07-12
updated: 2026-07-13
priority: high
feasibility: medium
task_type: refactor
area: codegen
es_edition: n/a
language_feature: error-throw
goal: maintainability
sprint: 71
horizon: m
umbrella: 3182
related: [3175, 3173, 3171, 3029, 3102]
---

# #3191 — bloat S1: unify the JS-error-throw templates

Slice **S1** of the #3182 code-bloat-elimination epic. See #3182 §D1.

## Problem

The "throw a real JS error instance" instruction template is hand-rolled in
≥4 places that each re-implement the same shape (noJsHost →
`emitWasiErrorConstructor`, `addStringConstantGlobal`, `ensureLateImport
__new_<Kind>`, `flushLateImportShifts`, string instrs, optional `call`,
`throw $exc`). The canonical implementation already exists:
`buildThrowJsErrorInstrs` (`src/codegen/expressions/helpers.ts:231`, #3175)
and the bare-string `emitThrowString` (`src/codegen/expressions/helpers.ts:38`).

Verified copies (2026-07-12, `origin/main`):

| Copy | Anchor | Divergence |
| --- | --- | --- |
| `dvTypeErrorThrow` | `src/codegen/dataview-native.ts:652` | no self-flush — caller pre-builds template before body (funcIdx-capture ordering) |
| `emitDataViewRangeError` | `src/codegen/dataview-native.ts:628` | same, RangeError |
| `emitBrandCheckTypeError` | `src/codegen/native-proto.ts:558` | sinks into a raw `Instr[]` (not fctx), unconditional `emitWasiErrorConstructor` |
| `emitThrowString` + `throwStringInstrs` | `src/codegen/array-methods.ts:137,144` | bare-string variant; `emitThrowString` is a **verbatim** private copy of `expressions/helpers.ts:38` |

## Approach (verified anchors)

1. **Hoist the canonical helpers first** into a layering-safe leaf module
   (suggest `src/codegen/js-errors.ts`); `expressions/helpers.ts` re-exports
   for existing importers. Runtime modules (dataview-native, native-proto,
   array-methods) must NOT import from `expressions/` (front-end layer,
   #3029 layering).
2. **Parameterize the two real divergences** via an options bag (not new
   copies): (a) sink = fctx vs raw `Instr[]`; (b) self-flush
   (`flushLateImportShifts`) vs caller-flushes — the DataView accessors build
   throw templates BEFORE the body (ordering documented at
   `dataview-native.ts:620-627`); preserve it EXACTLY (a wrong flush here is
   the #1839-class index-shift hazard).
3. **Delete** all four copies; route their call sites through the shared
   helper. `throwStringInstrs` (array-methods.ts:144) is used at
   :325/:1599/:1763/:7396/:7595 — re-route all.

## Acceptance criteria

- Zero test-diff (equivalence suite stable; test262 CI delta exactly 0
  regressions / 0 progressions attributable to this slice).
- All four copies deleted; call sites route through the shared helper.
- No new import cycles; `pnpm run typecheck` clean.

## Coordination

- `src/codegen/array-methods.ts` is a hot file (dev-array-hof, #3185 slices
  #3199-#3201, epic slices #3193/#3196). Re-anchor by symbol, not line;
  re-merge `origin/main` before enqueue.
- Predecessor for **S2 (#3192)** — #3192 consumes the hoisted `js-errors.ts`
  module.
