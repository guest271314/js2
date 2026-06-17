---
id: 2042
title: "standalone: Object.defineProperty/defineProperties residual — __obj_insert illegal cast + descriptor semantics over $Object (~340 tests)"
status: in-progress
sprint: Backlog
created: 2026-06-10
updated: 2026-06-14
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: objects, property-descriptors
goal: standalone-mode
related: [1888, 1472, 1905, 739, 797]
test262_bucket: standalone-defineproperty
test262_count: 340
es_edition: es5
origin: "2026-06-10 standalone-vs-host baseline diff: 365 defineProperty + 177 defineProperties gap rows; ~217 are #1472/#1888-owned refusals, the rest are real standalone runtime bugs tracked here."
---

# #2042 — standalone defineProperty/defineProperties residual

## Problem

`built-ins/Object/defineProperty` (365 gap rows) + `defineProperties` (177)
split into three failure classes in standalone where host passes:

**A. Runtime trap — compiler bug (37+ rows):**
`illegal cast [in __obj_insert() ← __defineProperty_value ← test]`
e.g. `built-ins/Object/defineProperty/15.2.3.6-4-*`. The supported
`__defineProperty_value` fast path itself feeds `__obj_insert` a
wrongly-typed key or value (likely numeric/symbol key reaching the
string-keyed insert arm). This is the same `$Object` runtime as #2039's
`__obj_find` signature and could be fixed in the same slice.

**B. Wrong descriptor semantics — runtime asserts (~300 rows incl.
defineProperties):** tests that compile and run but fail
`verifyProperty(...)` / flag checks:

- `assert(accessed, 'accessed !== true')` — accessor `get`/`set` from the
  descriptor object never invoked,
- `assert.sameValue(beforeWrite, true, 'beforeWrite')` — ValidateAndApply
  ordering ([§10.1.6.3](https://tc39.es/ecma262/#sec-validateandapplypropertydescriptor)),
- `assert(propertyDefineCorrect, …)` — attribute defaults (writable/
  enumerable/configurable default **false** for fresh descriptors,
  [§6.2.6.6 CompletePropertyDescriptor](https://tc39.es/ecma262/#sec-completepropertydescriptor)),
- redefinition rejections that must throw TypeError and don't.

**C. Loud refusals (already owned — NOT this issue):** ~217 rows
`'__defineProperty_desc' … is not yet supported in --target standalone
(#1472 Phase B)` — accessor-descriptor support is #1888 Slice 5 (D5,
`$PropEntry` funcref slots). This issue should land after or alongside that
slice and re-measure.

## Suggested approach

1. Fix A first (small, mechanical): typed-key dispatch before `__obj_insert`
   — numeric and symbol keys must take their own arm or be normalized; add a
   brand check instead of an unconditional `ref.cast`.
2. For B: implement ValidateAndApplyPropertyDescriptor over the `$PropEntry`
   flag word — attribute defaults, [[Configurable]] transition rules, and
   TypeError on invalid redefinition. `verifyProperty` harness coverage makes
   the spec-order observable, so follow §10.1.6.3 step order exactly.
3. Re-run the defineProperty/defineProperties directories standalone and
   reassign any residual rows.

## Acceptance criteria

- 0 `illegal cast` rows under `built-ins/Object/defineProperty` standalone.
- `verifyProperty`-based attribute-default and redefinition tests pass
  (≥150 of the ~300 class-B rows).
- TypeError thrown (catchable) on invalid redefinitions — no traps.
- Host mode unchanged; equivalence test for numeric + symbol keys through
  `Object.defineProperty` in standalone.

## Progress

### PR-A — key cast fix (2026-06-14, dev-b) — DONE

ToPropertyKey the `Object.defineProperty` key at the call site so a numeric /
boxed key reaches the string-keyed `$Object` runtime as a `$AnyString`,
eliminating the `illegal cast` trap (class A, 37+ rows).

- New helper `emitStandaloneDefinePropertyKeyToString` in
  `src/codegen/object-ops.ts` routes the compiled key externref through
  `__extern_toString` (host import in JS mode; native runtime helper in
  standalone), gated on `ctx.standalone` so host output stays byte-identical
  (the host `__defineProperty_value` JS import ToPropertyKeys the key itself and
  would alias a pre-stringified Symbol).
- Applied symmetrically in both the value path
  (`emitExternDefinePropertyValue`) and the accessor path
  (`emitExternDefinePropertyNoValue`).
- Verified: `Object.defineProperty(o, 0, {value:5})` no longer traps in
  standalone (was `illegal cast`); string-key define round-trips unchanged
  (`o.foo`); host mode untouched. Tests in `tests/issue-2042.test.ts`.
- Symbol keys: out of scope for Part A (the string-keyed runtime cannot
  represent them); the `15.2.3.6-4-*` illegal-cast rows are numeric, not symbol.

### Remaining (PR-B — senior follow-up)

- ValidateAndApplyPropertyDescriptor / CompletePropertyDescriptor over the
  `$PropEntry` flag word (class B, ~300 rows): attribute defaults, redefinition
  rules, catchable TypeError. Out of scope for this PR.
- Standalone defineProperty value readback via numeric/computed member access
  (`o[0]`) and enumeration (`Object.keys` / `getOwnPropertyNames`) over
  defineProperty'd keys are separate pre-existing gaps (the latter is refused
  loud under #1472 Phase B) — not introduced by PR-A.

### S1 — `__to_property_key` key hardening (2026-06-17, dev-1) — DONE

Central runtime key coercion, per the architect S1 plan. PR-A only ToPropertyKey'd
the `Object.defineProperty` *call site*; every OTHER caller (computed numeric
member access `o[0]`, `Reflect.get(o, 1)`, `Object.getOwnPropertyDescriptor(o, 0)`,
`delete o[0]`, `0 in o`) still fed a boxed number straight into the
`ref.cast $AnyString` and trapped `illegal cast [in __obj_find()]` (~170-230 rows).

- New `__to_property_key(externref) -> externref` native in
  `src/codegen/object-runtime.ts` (standalone-gated): `$AnyString` → unchanged
  (fast path); boxed number → `number_toString(__unbox_number(key))` (canonical
  decimal, `-0`→`"0"`, `1.5`→`"1.5"`); Symbol/opaque → unchanged (no NEW trap;
  Symbol keys stay a compile-time #1472 refusal).
- Wired via a guarded `withKeyCoercion` prologue at the top of **`__obj_find`,
  `__obj_hash`, AND `__obj_insert`** (the write path `__obj_insert` has its own
  key `ref.cast` + stores the key into `$PropEntry.key`, so it needed the same
  coercion — the architect's "find/hash only" claim missed the insert path; the
  write side `o[0]=v` trapped until insert was covered too). Inner re-coercion
  (e.g. `__obj_find`→`__obj_hash`) is idempotent (already-`$AnyString` fast-return).
- Verified standalone: numeric get/set round-trip, literal numeric key read,
  `getOwnPropertyDescriptor(o,0)`, `Reflect.get(o,1)`, decimal/`-0` keys, `in`,
  `delete` — all were `illegal cast`, now pass. tsc + prettier clean; host/gc
  mode untouched (`ctx.standalone`-gated). Tests: `tests/issue-2042.test.ts`
  ("S1 numeric-key ToPropertyKey hardening" block, 9 cases; 14/14 file total).
- **Out of S1 scope (separate pre-existing bug):** `o[0] + o[1]` still traps in
  `__any_add`→`__any_to_string` on the retrieved *values* (a value-coercion path,
  not a key cast) — confirmed identical on clean main. Likely folds into S2
  (#1910/#1472 boxed-primitive ToPrimitive). S1 is KEY hardening only.
- Provides the shared `__to_property_key` helper that #2046 PR-D / S3 should
  consume rather than adding their own coercion.
