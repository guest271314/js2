---
id: 2085
title: "array HOF predicate truthiness: buildTruthyCheck treats NaN and boxed 0/'' as truthy — contradicts ensureI32Condition's own spec matrix"
status: done
completed: 2026-06-14
sprint: 62
created: 2026-06-11
updated: 2026-06-15
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [2080, 2152]
origin: "2026-06-11 coercion-engine analysis (fable agent): code-derived divergence, found during site inventory"
---

> **2026-06-15 update (senior-dev):** the net −6 regression this PR (#1459)
> exposed was root-caused to the upstream `this`-binding bug **#2152** (array
> HOF callbacks ignored `thisArg`; callback `this` was always `undefined`).
> #2152 is now FIXED on this same branch via `__current_this` install/restore +
> `readsCurrentThis` on `this`-using function declarations (mode-agnostic, works
> standalone). With #2152 landed, the array-method suite shows **+17 / −0** vs
> the pre-#2152 branch — PR #1459 is net-positive. See
> `plan/issues/2152-thisarg-forwarding-array-hof-callbacks.md`.

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

## CI regression analysis (2026-06-15, senior-dev — PR #1459)

PR #1459 (this fix) is **net −6/−7 test262**: it FIXES 12 and REGRESSES 18-19.
I root-caused all 18 array regressions with runtime proof. **They are NOT a
`buildTruthyCheck` defect — the ToBoolean fix is correct.** They are
pre-existing `this`-modeling bugs that were *masked* by the two truthiness
bugs this PR removes.

### What the 18 regressions actually are

All callbacks here are **named function declarations** (`function callbackfn(){
return this.X }`) passed by reference, e.g. `arr.filter(callbackfn, o)`. Such a
callback compiles to the **closure path** (`call_ref`), with funcref signature
`(captures, elem, idx, arr) → result` — **no `this` parameter**. Inside the
callback body `this` is compiled as a literal `__get_undefined()` (proven:
`[1].map(function(){return this;})[0] === undefined`). So:

- **15 of 18** (`every/filter/some` `-5-2..6`): callback returns `this.PROP`
  with a **thisArg passed** whose PROP is truthy. thisArg is **not forwarded**
  to the closure → `this` is `undefined` → `this.PROP` is `undefined`/falsy.
- **3 of 18** (`every/filter/some` `-7-c-iii-26/27`, `-9-c-iii-28`): callback
  `return global` where `var global = this` at top level. Top-level `this` is
  compiled as `undefined` (should be the sloppy-mode global object) → falsy.

On **main**, these values are wrong (falsy) but two compensating truthiness
bugs render them truthy, matching the spec answer **by accident**:
- f64 arm `f64.ne 0` → NaN (from `Number(undefined)`) wrongly **truthy**;
- bare-externref arm `ref.is_null` → the non-null `undefined` sentinel wrongly
  **truthy**.

This PR replaces both with correct ToBoolean (`|x|>0`; `__is_truthy`), so the
wrong `undefined` value is now correctly falsy → element dropped → assertion
fails. Verified: on main `filter(cb,{res:true}).length === 3`, on PR `=== 0`,
**both via the missing-thisArg path** (Node gives 3 because thisArg IS bound).

### Why it cannot be fixed in buildTruthyCheck

The 12 improvements and 18 regressions flow through the **same ToBoolean arms**:
- genuine wins `return NaN` / `return ""` / `return false` use the f64-abs /
  `__is_truthy` / i32 arms — all this-independent, all correct;
- the regressions return `this.X` (→ `undefined`) which ALSO uses the
  `__is_truthy` arm and is ALSO correctly falsy.

At the ToBoolean layer a legitimately-falsy `""` and a broken-`this`
`undefined` are indistinguishable — both are falsy values being correctly
identified as falsy. **No arm-level lever separates them.** Reverting the
externref arm to `ref.is_null` to "recover" the regressions would re-break the
`""`/boxed-empty-string wins (and re-introduce the exact #2080/#2085 defect).
`if (undefined)` already correctly evaluates falsy via `ensureI32Condition`, so
masking it here would be a deliberate regression of correct ToBoolean.

### The 8 genuinely this-independent wins (keep these)

`every/some/filter -7-c-iii-12` (NaN), `-7-c-iii-13`/`-9-c-iii-14` (""),
`filter -9-c-iii-13` (NaN), `findIndex`/`findLastIndex
return-negative-one-if-predicate-returns-false-value` (boxed false). All 8
confirmed PASS on the PR branch and depend on nothing but the ToBoolean fix.

### Decision

The regression is **not fixable without the upstream `this` work**:
1. **Forward thisArg to HOF callbacks** (fixes 15) — requires giving the
   callback a dynamic `this` binding: either route thisArg-bearing callbacks
   through a new `.call`-aware host bridge (`fn.call(thisArg, …)`), or thread a
   `__this` param through the array-method `call_ref` closure ABI. Touches
   runtime + declarations + every functional array method, with its own
   object-return → f64 coercion surface. **Architect-spec sized.**
2. **Model top-level `this` as the sloppy-mode global** (fixes 3) — separate
   semantics change.

Masking the `this` bug inside `buildTruthyCheck` (re-breaking ToBoolean) is
rejected: it would re-introduce the defect this issue fixes and lose the `""`
wins. Tracked as **#2152 (thisArg forwarding to array HOF callbacks)**.

Recommendation to tech lead: **do not merge #1459 as-is** (net −6). Either (a)
land #2152 first so this PR becomes net-positive, or (b) merge #1459 + #2152
together. No code change to `buildTruthyCheck` will make #1459 net-positive on
its own — the branch is left unchanged (the ToBoolean fix is correct); the
blocker is the upstream `this`-modeling issue #2152.
