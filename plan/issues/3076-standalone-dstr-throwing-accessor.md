---
id: 3076
title: Standalone destructuring lane must honor throwing accessor getters / user @@iterator
status: done
assignee: ttraenkler/fable-3040
completed: 2026-07-10
sprint: 71
model: fable
priority: medium
horizon: m
feasibility: hard
blocks: [3040]
created: 2026-07-07
updated: 2026-07-13
---

# Standalone destructuring must invoke throwing accessor getters / user `@@iterator`

## Problem

The standalone (pure-Wasm) destructuring lowering does **not** invoke
user-defined accessor **getters** or a user-defined **`@@iterator`** while
binding a destructuring pattern. So a pattern like:

```js
var { p } = {
  get p() {
    throw new Test262Error();
  },
}; // getter never fires (standalone)
var [a] = iterableWithThrowingNext; // @@iterator/next never fires (standalone)
```

silently binds instead of throwing. In **host mode** the accessors are
invoked correctly; this gap is standalone-only.

## Why this surfaced now (#3040)

Discovered while unparking **#3040** ("thread param-default captures in
closures + object destructuring"). #3040 is net-correct
(+75 host pass, +12 genuine standalone fail→pass), but it exposed **14
standalone `dflt-*-err.js` false-passes**:

- On main those 14 (`default = <outer var>` destructuring where a getter /
  `@@iterator` throws) passed only _incidentally_: the outer var was **not
  captured** → the default read `null` → destructure-of-`null` threw a
  `TypeError`, and standalone `assert.throws(Test262Error, …)` is **lenient**
  (opaque WasmGC thrown values ⇒ any throw counts as a pass). So they were
  **false-passes**, not real coverage.
- #3040 correctly captures the outer var, removing the incidental
  null-throw. The _intended_ getter / `@@iterator` throw still does not fire
  (this gap), so `f()` doesn't throw at all → the lenient `assert.throws`
  now fails. Hence the 14 standalone flips (host mode: all 14 correctly pass).

The 14 are therefore a symptom of THIS gap, not a #3040 regression. #3040 is
**gated on this issue** (`blocks: [3040]`): once the standalone destructuring
lane invokes throwing accessors / user `@@iterator`, the 14 genuinely pass
and #3040 can land.

## Acceptance criteria

1. Standalone object-pattern binding invokes a property's accessor **getter**
   (and propagates a thrown value) at the spec-mandated point
   (GetV / ToObject-then-Get ordering, before default evaluation where the
   spec requires).
2. Standalone array/iterable-pattern binding invokes the user
   **`@@iterator`** + `next()` and propagates thrown values.
3. The 14 `dflt-*-err.js` standalone tests identified under #3040 flip to
   genuine pass (getter/`@@iterator` actually throws), with #3040's branch
   merged.
4. No standalone regressions in the broader
   `language/**/dstr/**` corpus (scoped sweep, 0 net pass→fail).

## Notes

- The lenient standalone `assert.throws` (opaque WasmGC thrown values ⇒ any
  throw passes) is a separate, known harness limitation; this issue is about
  the codegen lane actually invoking the accessors, not the harness.
- Related substrate: standalone value-read / `$Object` dynamic reader.

## Implementation (2026-07-10, fable-3040)

**Measure-first on CURRENT main** (a2c2915a7f): criterion 2 (user `@@iterator`
/ `next()` drive + throw propagation) had **already landed** since this issue
was filed — #3100 S4/S5 (native GetIterator ladder + IteratorClose) and #3119
(plain-`$Object` `@@iterator` OBJ arm in the native `__iterator` ladder) cover
every `iter[Symbol.iterator] = fn` shape, verified by per-shape probes (for-of,
destructure, throwing `@@iterator`, throwing `next()`, module + function
scope). What remained broken was criterion 1's dominant shape:

**Root cause (the one real gap left):** TS's generic
`Object.defineProperty<T>(o: T, …)` gives an inline `{}` receiver a CONCRETE
empty contextual type, so `compileObjectLiteral`'s any-context arm never fires
and the literal lowers to a **closed struct** (`struct.new_default`). The
standalone runtime store `__defineProperty_accessor` is a **lenient no-op on a
non-`$Object` receiver**, so `var o = Object.defineProperty({}, "p", { get()
{ throw … } })` silently dropped the accessor — every later read (member read
AND destructuring GetV, §13.3.3.7 step 4) returned undefined instead of firing
the poisoned getter. This is exactly the test262
`dstr/*obj-ptrn-*get-value-err` + `*ary-ptrn-*-iter-val-err` shape (the latter
builds the next-result's poisoned `value` getter the same way — so fixing the
receiver composes with #3119's dynamic read arm).

**Fix** (`src/codegen/literals.ts`, standalone/wasi-gated): an empty `{}` that
is the receiver argument of `Object/Reflect.defineProperty/defineProperties`
builds as an open `$Object` (`__new_plain_object`), so the native accessor
store and the `__extern_get` accessor dispatch (#1888 S5b) service it
end-to-end. Host/gc lanes byte-identical (sha256-verified base-vs-branch).

**Measured** (`language/**/dstr/**/*-err*.js`, 897 files, standalone,
base=main a2c2915a7f): **371 → 568 pass (+197, 0 regressions)**. Flipped
families: `obj-ptrn-{id,prop-id}-get-value-err` (all 11 forms each),
`ary-ptrn-{elem,rest}-id-iter-val-err` (all 11 each), plus their `dflt-*` /
`meth-*` variants — including the #3040-gate `dflt-obj-ptrn-*` files.

**Residuals (out of scope, different root causes):**

- `*-elision-step-err` / `*rest-id-{iter-step,elision-next}-err`: the sources
  are **generators**; the elision/rest drive over the native generator carrier
  doesn't propagate the step throw (and `isPatternEmptyOnly` skips the
  spec-mandated IteratorStep for `[,]`, #1016/#1158 trade-off).
- `*-array-prototype` variants: `delete Array.prototype[Symbol.iterator]` /
  override on REAL arrays — the #1719 ITER_OVERRIDDEN brand lane, not the
  `$Object` protocol.
- Function-LOCAL `const o: any = {}` + `Object.defineProperty(o, …)` statement
  routes to the S5c static-struct accessor (closure in a module global), which
  destructuring's `__extern_get` read cannot see. Not a test262 shape in this
  corpus (module-level `var` receivers all go through the runtime store).

## Test Results

- `tests/issue-3076.test.ts` — 6/6 standalone: var-decl destructure fires the
  poisoned getter, param-position destructure, plain read, non-throwing getter
  VALUE read, `defineProperties`, data-descriptor read-back control.
- Related suites green: issue-1901 (7), issue-1372 (10), issue-1128,
  fn-param-dstr-rest-in-rest. (`issue-1888.test.ts` / `issue-1888-s6c.test.ts`
  each have 1 refuse-loud guardrail failure that reproduces on UNMODIFIED
  main — pre-existing, not this change.)
- Host-lane byte-identity: defineProperty-accessor program + control program,
  base vs branch, host target — sha256 identical; only the standalone
  defineProperty program differs.
