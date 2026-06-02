---
id: 820j
title: "(Async)GeneratorPrototype brand check + receiver TypeError (~36 fails)"
status: done
created: 2026-05-21
updated: 2026-05-28
completed: 2026-05-28
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: builtins
language_feature: generator-prototype
goal: async-model
sprint: 56
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
