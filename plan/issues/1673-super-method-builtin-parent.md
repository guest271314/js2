---
id: 1673
title: "super.<method>() on a built-in parent class fails to compile"
status: ready
created: 2026-05-27
updated: 2026-05-27
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: class
goal: spec-completeness
sprint: Backlog
parent: 1675
---
# #1673 — super.<method>() on a built-in parent class fails to compile

Split from #1675 (built-ins/Set investigation).

## Problem

A class that extends a built-in (`Set`, `Map`, `Array`, …) and calls a
`super`-inherited method fails at **compile time**:

```js
class MySet extends Set {
  size(...rest) { return super.size(...rest); }   // CE
  has(...rest)  { return super.has(...rest); }     // CE
  keys(...rest) { return super.keys(...rest); }    // CE
}
```

Error: `Cannot find method 'size' on parent class 'Set'`.

## Affected tests (7 compile_errors in built-ins/Set)

`prototype/{union,intersection,difference,symmetricDifference,isSubsetOf,
isSupersetOf,isDisjointFrom}/subclass-receiver-methods.js`

(All assert that `Set.prototype.union` & friends never call the *receiver's*
overridden `size`/`has`/`keys` — but they fail before that, at compile.)

## Root cause

`compileSuperMethodCall` in `src/codegen/expressions/new-super.ts:108-120`
resolves `super.<m>` by walking `ctx.funcMap` for `${ancestor}_${m}`, climbing
`ctx.classParentMap`. When the ancestor is a **built-in class**, there is no
`Set_size` (etc.) funcMap entry — built-ins are host-backed, not user-compiled —
so the loop exhausts and hits the hard `reportError` at new-super.ts:118
(mirror at :208 for the `super['m']()` computed form).

## Direction

When the resolved `parentClassName` is a known built-in and no user funcMap
entry exists, dispatch `super.<method>(args)` to the built-in's prototype method
via the existing host-method machinery (the same path that compiles
`obj.method()` for built-in receivers), with `this` as the receiver — instead of
erroring. Both `compileSuperMethodCall` (:118) and
`compileSuperElementMethodCall` (:208) need the fallback.

## Acceptance

- The 7 `subclass-receiver-methods.js` tests compile (then pass or fail on
  their actual assertions, not CE).
- No regression in user-class `super.method()` dispatch.
