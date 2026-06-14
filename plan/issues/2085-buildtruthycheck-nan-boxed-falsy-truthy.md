---
id: 2085
title: "array HOF predicate truthiness: buildTruthyCheck treats NaN and boxed 0/'' as truthy — contradicts ensureI32Condition's own spec matrix"
status: done
completed: 2026-06-14
sprint: 62
created: 2026-06-11
updated: 2026-06-14
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [2080]
origin: "2026-06-11 coercion-engine analysis (fable agent): code-derived divergence, found during site inventory"
---

# #2085 — second hand-rolled ToBoolean disagrees with the first

## Problem

`buildTruthyCheck` (src/codegen/array-methods.ts:5121) — the truthiness
test used by array HOF predicate results (filter/find/some/every style
callbacks returning non-boolean values) — treats `NaN` and boxed `0`/`""`
as truthy, contradicting §7.1.2 ToBoolean AND the compiler's own
`ensureI32Condition` implementation (src/codegen/index.ts:11696), whose
spec-comment matrix it fails to match.

Expected repro shape (verify when claiming):

```ts
[1, 2, 3].filter((x) => NaN as any)        // wasm keeps all, node keeps none
[0, 1].find((x) => (x as any))             // boxed-0 predicate result truthy
```

## Root cause

Duplicated ToBoolean lowering: `buildTruthyCheck` is an independent
hand-rolled copy that drifted from `ensureI32Condition`. Exactly the
drift class the coercion-engine consolidation
(plan/log/analysis-2026-06/03-coercion-engine-spec.md, Step 4) retires —
fix is either a one-off correction now or absorption into the engine's
emitToBoolean.

## Acceptance criteria

- Repro shapes match Node; predicate truthiness identical to `if (v)`
- buildTruthyCheck and ensureI32Condition agree (ideally one
  implementation)

## Dupe check

#2080 covers any-boxed empty-string truthiness in ensureI32Condition's
helper (standalone); this is the SEPARATE array-methods copy. Found
during the 2026-06 coercion-site inventory; no existing issue. New.

## Resolution (2026-06-14, dev-a)

`buildTruthyCheck` / `buildFalsyCheck` (src/codegen/array-methods.ts) now route
through a shared `buildToBooleanInstrs` that mirrors `ensureI32Condition`:
- **f64** → `f64.abs; f64.const 0; f64.gt` (NaN / +0 / -0 falsy; the old
  `f64.ne 0` made NaN truthy);
- **any-boxed ref** (`isAnyValue`) → `__any_unbox_bool` (proper JS truthiness on
  the boxed value — fixes boxed `0`/`""`/`false`/`NaN` wrongly truthy);
- **externref** → `__is_truthy`;
- **native-string ref** → flatten + len>0 (empty string falsy);
- **i32/i64** → as-is / `i64.eqz;i32.eqz`.
`buildFalsyCheck` is now `!buildToBoolean` (reuse + `i32.eqz`).

### Test results

`tests/issue-2085.test.ts` — 7/7: filter NaN → keeps none, boxed-0/""/false
predicates → falsy, truthy keeps all, `find([0,1], x=>(x as any))` → 1, some/every
boxed-falsy, and normal boolean predicates unaffected. No regressions
(`issue-2074` green; the pre-existing functional-array-methods.test fixture
failures — "number|undefined not assignable" TS errors — reproduce identically
on baseline main and are unrelated).

### Residual (out of scope)

`[...].find((x) => (0 as any))` with an INLINE `(literal as any)` boxes the
closure RESULT to **externref** (not a `$AnyValue` ref), so it routes to
`__is_truthy(externref)`; the host `__is_truthy` is `v?1:0`, which sees the
WasmGC box wrapper as truthy. That is a separate closure-return-boxing /
`__is_truthy`-unwrap concern (the `buildTruthyCheck` drift this issue names is
fixed — element-typed and variable-boxed `any` predicates, the common shapes,
all work via `__any_unbox_bool`).
