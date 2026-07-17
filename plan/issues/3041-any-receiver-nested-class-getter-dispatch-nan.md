---
id: 3041
title: "get-accessor via an any-typed receiver on a class declared inside a function returns NaN/undefined (dynamic accessor dispatch gap)"
status: in-progress
assignee: ttraenkler/dev-conform
sprint: current
created: 2026-07-05
updated: 2026-07-17
priority: medium
horizon: m
feasibility: medium
task_type: bugfix
area: codegen
language_feature: classes, accessors, dynamic-dispatch
goal: spec-completeness
related: [3039, 634, 1395]
---

# #3041 — get-accessor via `any` receiver on a nested class returns NaN (dynamic accessor dispatch gap)

Split out from #3039 (the accessor boxed-capture fix) as an explicitly-separate,
pre-existing bug. It is **orthogonal to captures** — a getter returning a
**constant** hits it too.

## Symptom

A `get` accessor invoked through an **`any`-typed receiver**, where the class is
**declared inside a function** and the instance is returned out, reads NaN /
undefined instead of running the getter:

```ts
// all return NaN via the any-receiver + nested-class shape:
function make() { class K { get v(): number { return 42; } } return new K(); }
const o: any = make();
o.v;                       // NaN — getter body never runs (constant! no capture)

function make2() { class K { x: number = 7; get v() { return this.x; } } return new K(); }
(make2() as any).v;        // NaN — own-field getter, also NaN
```

Contrast (these WORK, proving it is the dynamic *getter dispatch*, not the class
or the value):
- **Static** dispatch (typed receiver / top-level class): `class K { get v(){...} }`
  read via `o: K` or a top-level `new K()` → correct.
- A **method** (not a getter) via the same `any` receiver + nested class:
  `class K { v(){ return 42; } }; (make() as any).v()` → correct (42).

So the gap is specifically: **dynamic property GET that must resolve to a
get-accessor** on a WasmGC struct instance reached via an `any` receiver, for a
class compiled inside a function. The dynamic-get path returns the field/default
(NaN) instead of dispatching to the accessor's `__cb`/getter function.

## Why filed separately (not folded into #3039)

Confirmed pre-existing and capture-independent (the constant-getter case above
has no capture). #3039's additive `capturedBoxGlobals` branches are no-ops for
non-boxed names, so #3039's codegen for these cases is byte-identical to main —
#3039 does NOT introduce or fix this. #3039's boxed-capture getter READ fix is
proven via the **static-dispatch** getter (→ correct) and the
method-read-via-any (→ correct); only the `any`-receiver *accessor dispatch*
remains.

## Acceptance

- `(make() as any).v` invokes the getter (constant, own-field, and captured
  variants) for a class declared inside a function.
- No regression in `getters-setters` / `accessor-side-effects` / dynamic
  property-access suites.

## Notes

- Look at the dynamic property-GET dispatch for local-class struct instances
  reached via `any` (the `__get_member_<name>` / `__cb` accessor path vs the
  plain struct-field/default read). Compare against the working **method**
  dispatch on the same receiver shape — methods resolve, accessors don't.
