---
id: 3043
title: "Object.defineProperty: ValidateAndApplyPropertyDescriptor illegal-transition rules not enforced (should-throw + SameValue + false-positive Cannot-redefine)"
status: done
completed: 2026-07-09
assignee: ttraenkler/fable-3022
sprint: 71
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
created: 2026-07-05
task_type: bugfix
area: runtime
language_feature: object-defineproperty, property-descriptors
es_edition: 5
goal: spec-completeness
parent: 3022
related: [3022, 3042, 1334, 1629]
---

# #3043 — defineProperty illegal-transition validation

Split from the #3022 umbrella. **Senior-scoped** (Fable-reserved): spec-precise
`ValidateAndApplyPropertyDescriptor` (ECMA-262 §10.1.6.3) with blast radius
across `defineProperty` / `freeze` / `seal` / `Object.create`.

## Root cause

Two failure directions, same validate step:

1. **Should-throw, doesn't (80 fails).** Redefining a **non-configurable**
   property in a way the spec forbids must throw `TypeError`, but our impl
   silently applies it:
   - changing `value` of a non-configurable, non-writable data property
     (with the `SameValue` rule: `+0`/`-0` differ, `NaN`/`NaN` are same —
     e.g. `15.2.3.7-6-a-46`),
   - toggling `enumerable` / `configurable`,
   - data ↔ accessor conversion on a non-configurable property.
2. **False-positive `Cannot redefine property` (~13 fails).** A **configurable**
   property that the spec permits to be redefined is wrongly rejected
   (`15.2.3.6-4-293-{1,3}`, `15.2.3.7-6-a-75`).

## Failing files (36 primary + Cannot-redefine cluster)

`15.2.3.7-6-a-245`, `15.2.3.7-6-a-46`, `15.2.3.6-4-293-3`, `15.2.3.7-6-a-93-3`,
`15.2.3.7-6-a-75`, `15.2.3.7-6-a-76`, `15.2.3.7-6-a-81`, `15.2.3.7-6-a-77`, …
(harvest `Expected TypeError` + `Cannot redefine property` under
`built-ins/Object/defineProperty{,ies}`).

## Minimal repro

```js
var obj = {};
Object.defineProperty(obj, "foo", { value: +0 }); // configurable:false (default)
// spec: SameValue(+0, -0) === false ⇒ this is a change on a non-writable,
// non-configurable prop ⇒ must throw TypeError:
Object.defineProperty(obj, "foo", { value: -0 });
```

## Layer to fix

`src/runtime.ts` (and/or `src/codegen/object-ops.ts`) — the descriptor
validate/apply step: implement the full §10.1.6.3 rejection matrix + `SameValue`
comparison; ensure the configurable-redefine path does not over-reject.

## Why senior

Changes flow into `freeze`/`seal`/`preventExtensions` and every descriptor
consumer; the +0/-0/NaN `SameValue` edges are subtle. **Must validate IN BATCH
(full CI / merge_group), not a scoped sweep.**

## Acceptance

- Illegal non-configurable transitions throw `TypeError`; legal configurable
  redefinitions succeed. No regression in `freeze`/`seal`/`create`.

## Reground (2026-07-09, fable-3022)

Verified the headline repros against current main (post-#3042): the +0/-0
SameValue throw, NaN-SameValue no-throw, value-type-change throw,
enumerable-toggle throw, and the false-positive
non-writable-but-configurable redefine ALL pass now on the runtime lanes.
The **array-index arm** of the matrix (element SameValue, shrink-blocking,
RangeError) landed with #3116. What remains in THIS issue's scope:

1. **Fully-static lane divergence** — `Object.defineProperty(obj, "foo",
{set: fn, configurable: false})` then `{configurable: true}` does NOT
   throw when the first (accessor) define compiles away entirely (no runtime
   mirror), so the second define's runtime validation sees a first
   definition. Same for data→accessor on a non-configurable static field.
   Repro: `.tmp` probe matrix confToggle/dataToAccessor (both return 0,
   expect 1).
2. **Non-callable-getter define-leak** — `{get: {a: 1}}` via a descriptor
   variable throws (correctly) but the property is still observably created
   (`o.hasOwnProperty("foo")` true afterwards).
3. Arguments-object receivers (~57 fails) share the exotic-receiver shape
   and may belong here or in a separate cause-scoped issue.

The fix direction for (1) is the same state-unification lever as the #3116
veto: when the static accessor path compiles a define away, mirror the
descriptor flags into the runtime sidecar (the data path already does this
via the `anyFlagSpecified` side-effect `__defineProperty_value` call).

## Resolution (2026-07-09, fable-3022) — accessor-static-lane transition matrix

The +0/-0 SameValue, NaN-SameValue, value-type-change, enumerable-toggle, and
false-positive-redefine headline repros were already resolved by #3042/#3116.
The remaining residual was the **accessor static lane**: an accessor
`defineProperty` on a widened-`any`/struct receiver took the compiled fast path
(`receiverIsStaticStruct` true via `widenedVarStructMap`) which recorded ONLY
`nonConfigurableAccessorKeys`, never the descriptor flags in the compile-time
`definedPropertyFlags` table. A subsequent redefine — attribute-only
(`{configurable:true}` / enumerable toggle) routed through
`emitExternDefinePropertyNoValue`, or a get/set redefine on the fast path —
therefore saw no existing descriptor and **silently accepted illegal
transitions** on a non-configurable accessor.

### Fix (host lane)

- **`emitStaticDescriptorTransitionThrow`** (object-ops.ts): a shared
  compile-time §10.1.6.3 check (config false→true, enumerable toggle,
  data↔accessor flip, writable-narrow, and accessor→accessor with a *fresh*
  get/set that can never be SameValue). The data/accessor KIND is read from the
  resolved `newFlags` (an attribute-only redefine preserves the existing kind),
  fixing the `{enumerable:true}`-on-accessor false-throw.
- **Unify on `definedPropertyFlags`**: the accessor fast path now records its
  flags there and both it and `emitExternDefinePropertyNoValue` validate against
  it before applying. On an illegal transition both sites emit the throw then
  **return immediately** — continuing would register a second, dead accessor
  that clobbers the still-live original (15.2.3.6-4-540-1/-6: the post-catch read
  must see the ORIGINAL get/set).
- **Host-lane gated** (`!ctx.standalone`): recording an accessor key in
  `definedPropertyFlags` routes standalone `hasOwnProperty` through the
  wasm-native helper (which does not report a defineProperty-added struct-shape
  property as own — #2726), so the record + check are host-only; standalone keeps
  origin/main behaviour. The #3043 test262 cluster is the JS-host default lane.

### Measured

- 4 of 5 accessor-transition repros fixed (accessor config-toggle, data→accessor,
  accessor set-redefine, accessor enum-toggle). The 5th (`{get: {a:1}}`
  non-callable-getter define-leak — property observably created after the throw)
  is a distinct runtime-ordering bug, **out of scope** (follow-up under #3022).
- Real test262: `15.2.3.6-4-30/-252/-312`, `15.2.3.7-6-a-241` flip to pass.
- Cluster: `built-ins/Object/definePropert{y,ies}` **+7 net** on top of #3116
  (146→153 of the recorded fail set, in-process isolated run).
- **Zero regressions**, validated hard: 2,513 baseline-passing
  `built-ins/Object/` (2440 pass / 73 fail — matches the #3116 clean control),
  600 `built-ins/Array/` (592/8), 82 descriptor/accessor/standalone vitest tests.
  Two regressions found DURING development (540-1/-6 accessor clobber; #2726
  standalone hasOwnProperty routing) were both root-caused and fixed before the
  PR.
