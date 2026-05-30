---
id: 1739
title: "String.prototype methods fail not-a-constructor (A7) + .length-DontEnum (A8) invariants across the suite"
status: done
created: 2026-05-29
updated: 2026-05-30
completed: 2026-05-30
priority: medium
feasibility: medium
task_type: bugfix
area: codegen
language_feature: builtin-function-objects, string-methods
goal: test262-conformance
sprint: Backlog
es_edition: 5
test262_fail: ~40
related: [930, 1632, 1731]
---
# #1739 — String.prototype method function-object invariants (A7 not-a-constructor, A8 .length DontEnum)

## Problem

Across nearly every `built-ins/String/prototype/<method>/` cluster, the
recurring residual failures are the standard ES5 function-object invariant
tests, NOT value semantics:

- **`S15.5.4.*_A7.js`** — `String.prototype.<method>` cannot be used as a
  constructor: `new String.prototype.indexOf` must throw `TypeError`
  ([§20.2.3 / §10.2 — built-in methods have no `[[Construct]]`]).
- **`S15.5.4.*_A8.js`** — `String.prototype.<method>.length` exists, is an own
  property, and is **non-enumerable** (`propertyIsEnumerable('length')` false;
  `for-in` does not surface it).

These recur in: `indexOf`, `substring`, `slice`, `charAt`, `lastIndexOf`,
`includes`, `concat`, `toLowerCase`/`toUpperCase`/`toLocale*case`, etc. —
roughly 2 fails per method × ~20 methods (~40 total), all the same two root
causes.

## Root-cause hypothesis

Compiled `String.prototype` methods are emitted as host-imported / wasmGC
shims that are not materialized as real inspectable **builtin function
objects**: they (a) do not reject `new` with a TypeError (no `[[Construct]]`
guard — same family as the now-fixed #930 for `Array`/built-in methods), and
(b) expose no own, non-enumerable `length` property when accessed via
`String.prototype.<method>`.

This is the **function-object materialization** gap for built-in
String.prototype methods — related to the bound-function / function.prototype
representation work (#1632) and the #930 not-a-constructor detection. It is a
shared cause, so a single fix (materialize String.prototype methods as builtin
function objects with a non-enumerable `length` and no `[[Construct]]`) clears
the whole `A7`/`A8` row at once.

Spec: §20.2 (function objects), §10.2.4 (built-ins lack `[[Construct]]` unless
specified), §17 (built-in function `length`/`name` are non-enumerable).

## Acceptance criteria

- `new String.prototype.indexOf` (and the other methods) throws `TypeError`.
- `String.prototype.<method>.length` is an own, non-enumerable property; the
  `*_A7.js` and `*_A8.js` clusters flip to pass.
- No regression in String value-semantics tests or in #930.

## Source

Filed by #259 conformance-triage 2026-05-29. The value-semantics half of the
substring/slice clusters is the localized #1731 (shipped); this issue tracks
the cross-method function-object invariant half.

---

## 2026-05-30 — Smoke-test verdict: ALREADY GREEN on main (stale baseline). DONE.

**Status: done — stale-baseline close, not a code fix.** Per the smoke-first
directive, ran the `S15.5.4.*_A7` (not-a-constructor → TypeError) and `_A8`
(`.length` own + non-enumerable) invariants against current `main` (HEAD
`518d55808`) at the compiler level. BOTH rows are already green:

- **A7 — 21/21 pass.** `var f = String.prototype.<m>; new f` throws a real
  `TypeError` instance for every sampled method (indexOf, lastIndexOf, charAt,
  charCodeAt, slice, substring, substr, toLowerCase, toUpperCase, concat,
  includes, split, trim, valueOf, …). The not-a-constructor work already closed
  this: `resolvesToNonConstructableValue` in
  `src/codegen/expressions/new-super.ts` detects a `<x>.prototype.<method>`
  initializer and routes `new f` through the `__construct` IsConstructor guard,
  which throws a TypeError (#930 + #1528 + #1732-S1 new-site check).
- **A8 — 14/14 pass.** `String.prototype.<m>.hasOwnProperty('length')` is true,
  `propertyIsEnumerable('length')` is false, and `for-in` does not surface
  `length`. The `test262_fail: ~40` count in the frontmatter was a **stale
  jsonl baseline** entry.

**Investigation note (false alarm avoided):** an early probe reported A7 as
failing, but that was a *probe artifact* — it used
`(String.prototype as any).indexOf` (an inner `as any` cast added to satisfy
TS), and that wrapped shape defeats the `.prototype` detection in
`resolvesToNonConstructableValue` (it sees an `AsExpression`, not a
`PropertyAccessExpression` whose object is `<x>.prototype`). The real test262
form — `var f = String.prototype.<m>` with no inner cast — passes. (If a future
issue wants the cast-wrapped form to also reject, that is the same family as
this guard's unwrap list, a small follow-up — but it is NOT what the A7 suite
exercises, so it is out of scope here.)

### What landed
- `tests/issue-1739.test.ts` — a 28-case pin (14 A7 + 14 A8) mirroring the exact
  test262 assertion shapes, LOCKING the green state against regression. No
  compiler change.

The `test262_fail: ~40` entry self-corrects on the next `promote-baseline` CI
run (push to main); the pin guards the behaviour in the meantime.
