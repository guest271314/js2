---
id: 3646
title: "Object.getOwnPropertyDescriptor returns null for a class prototype method when the class has computed-name fields, while hasOwnProperty says true"
status: ready
sprint: current
created: 2026-07-26
updated: 2026-07-26
priority: high
horizon: m
feasibility: medium
task_type: bug
area: codegen, runtime
language_feature: class-elements
goal: core-semantics
related: [3603, 3647, 2984]
origin: "cohort tracker for failures exposed by #3603 S1 host de-inflation (PR #3635)"
---

# #3646 — `getOwnPropertyDescriptor` returns `null` for a class method when the class has computed-name fields

> **Cohort tracker.** This is one of the two failure cohorts EXPOSED (not caused)
> by #3603 S1's host-lane de-inflation. Per the #3468 F1 landing recipe, every
> exposed cohort is routed to a tracker — that is what makes a de-inflation
> honest rather than banked. **This defect predates #3603 S1 and reproduces on
> stock `upstream/main`.**

## Problem

For a class that has **computed-name field definitions**, the compiler's
`Object.getOwnPropertyDescriptor(C.prototype, "m")` returns **null/undefined**
for a method `m` that demonstrably exists — `hasOwnProperty(C.prototype, "m")`
returns `true` for the same key in the same program.

That is an internal contradiction in our own reflection surface: the object
claims to own the property, but no descriptor can be produced for it.

## Measured (stock `upstream/main`, host lane, no test262 harness involved)

Probe compiles the class shape from
`test/language/expressions/class/elements/same-line-gen-computed-names.js` and
queries the MOP directly. All observations use a **numeric** return channel
(a string return channel is unreliable — see #3603's probe notes).

```js
var x = "b";
var C = class {
  [x] = 42;
  [10] = "meep";
  ["not initialized"];
  *m() {
    return 42;
  }
};
```

| query                                                   | observed |         spec |
| ------------------------------------------------------- | -------: | -----------: |
| `Object.getOwnPropertyDescriptor(C.prototype,'m')`      | **null** | a descriptor |
| `Object.prototype.hasOwnProperty.call(C.prototype,'m')` |     true |         true |
| for-in over `C.prototype` finds `'m'`                   |    false |        false |

**Identical with #3603 S1 applied and reverted** — i.e. S1 does not influence
these values; it only made the resulting harness failure reportable.

Control: for a _simple_ class (`var C = class { m() { return 42; } }`) the same
query returns a correct descriptor (`enumerable:false, writable:true,
configurable:true`). So the trigger is the **computed-name field definitions**,
not class methods in general.

## Why it matters

`propertyHelper.js`'s `verifyProperty` reads `originalDesc = __getOwnPropertyDescriptor(obj, name)`
and then compares `desc.enumerable !== originalDesc.enumerable`. With
`originalDesc` undefined, that comparison is trivially true, so **every
`verifyProperty` call against such a prototype reports a spurious-looking but
genuinely-caused failure.** This is a large share of the `class/elements`
cohort surfaced by #3603 S1.

## Acceptance criteria

- `Object.getOwnPropertyDescriptor(C.prototype, 'm')` returns a descriptor for
  a method on a class that also has computed-name fields.
- The descriptor is spec-correct: `enumerable:false, writable:true, configurable:true`.
- `hasOwnProperty` / `gOPD` / `for-in` / `Object.keys` agree with each other for
  the same key (no internal contradiction).
- Assert across **shapes**, not one: simple class, class with computed-name
  fields, class with a generator method, class expression vs declaration.
  (#3642's lesson: an unvaried axis is an assumption, not a measurement.)

## Reproduction

`.tmp/3603/attribution.mts` and `.tmp/3603/enum-check.mts` in the #3603 S1
worktree; both are self-contained `compile()` + `buildImports()` probes.
