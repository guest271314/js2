---
id: 1739
title: "String.prototype methods fail not-a-constructor (A7) + .length-DontEnum (A8) invariants across the suite"
status: ready
created: 2026-05-29
updated: 2026-05-29
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
