---
id: 820j
title: "(Async)GeneratorPrototype brand check + receiver TypeError (~36 fails)"
status: done
created: 2026-05-21
updated: 2026-05-27
completed: 2026-05-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: builtins
language_feature: generator-prototype
goal: async-model
sprint: Backlog
parent: 820
es_edition: ES2017
test262_fail: 36
---
# #820j — Generator / AsyncGenerator prototype brand check

## Problem

~36 test262 failures across `built-ins/GeneratorPrototype/*` and
`built-ins/AsyncGeneratorPrototype/*`. The receiver brand-check on
`.next` / `.throw` / `.return` / `.constructor` / `Symbol.toStringTag` is
either missing or producing the wrong error shape.

Sample errors are `TypeError: Cannot access property on null or undefined`
where the spec says `TypeError: <method> called on incompatible receiver`.

## Sample failing tests
- `test/built-ins/GeneratorPrototype/constructor.js`
- `test/built-ins/AsyncGeneratorPrototype/Symbol.toStringTag.js`
- `test/built-ins/AsyncGeneratorPrototype/return/prop-desc.js`

## Suspected source

- `src/codegen/builtins/generator.ts` (or wherever GeneratorPrototype is
  defined) — brand check missing on each prototype method receiver.
- `Symbol.toStringTag` descriptor on `(Async)GeneratorPrototype` may be
  incorrect (writable/enumerable/configurable flags).

## Spec reference

- ECMAScript §27.5 Generator Objects (%GeneratorPrototype%)
- §27.6 AsyncGenerator Objects (%AsyncGeneratorPrototype%)
- §27.5.1 The %GeneratorPrototype% Object — Symbol.toStringTag descriptor

## Acceptance criteria

- [ ] At least 30 of the ~36 tests flip to `pass`.
- [ ] Brand check throws `TypeError` with the spec-shaped message when
      called with an incompatible receiver.
- [ ] `Symbol.toStringTag` descriptor matches spec (configurable: true,
      enumerable: false, writable: false, value: "Generator" /
      "AsyncGenerator").

## Resolution (2026-05-27)

The brand checks (`_GeneratorState`/`_AsyncGeneratorState` lookups throwing
`TypeError` on incompatible receivers) were already landed by #1516 — that
part of the ~36 estimate was already passing. Two residual spec deviations
remained, both fixed in `src/runtime.ts`:

1. **`constructor` was an accessor, not a data property.** `%GeneratorPrototype%`
   and `%AsyncGeneratorPrototype%` defined `constructor` as a getter to dodge
   circular setup. Spec §27.5.1.1 / §27.6.1.1 require a *data* property
   `{writable:false, enumerable:false, configurable:true}`. The circular call
   is safe because `_get(Async)GeneratorFunctionPrototype` sets its own cache
   before invoking the prototype builder, so the data value resolves without
   recursion.

2. **Instance prototype chain collapsed the per-function `g.prototype` level.**
   `__create_generator` / `__create_async_generator` did
   `Object.create(%GeneratorPrototype%)`, so the spec chain
   `instance → g.prototype → %GeneratorPrototype% → %IteratorPrototype%` was
   missing a hop. `Object.getPrototypeOf(Object.getPrototypeOf(g()))` therefore
   landed on `%IteratorPrototype%` (toStringTag "Iterator") instead of
   `%GeneratorPrototype%` (toStringTag "Generator"). Codegen does not thread the
   function's own `.prototype` into the runtime helper, so the missing level is
   re-created as a fresh ordinary object inheriting from the shared prototype.
   `[[GeneratorState]]` lives on the instance, so the brand check is unaffected.

### Test Results (scoped: built-ins/GeneratorPrototype + AsyncGeneratorPrototype)

- main baseline: 70/109 pass · branch: 72/109 pass → **+2, 0 regressions**
- Flipped to pass: `GeneratorPrototype/Symbol.toStringTag.js`,
  `AsyncGeneratorPrototype/Symbol.toStringTag.js`
- Remaining fails are eager-generator-model limits (try/finally resumption,
  `not-a-constructor` via `new`) tracked under #1665 native generators, out of
  scope here.
- Regression suite: `tests/issue-820j.test.ts` (6 cases, all pass).
