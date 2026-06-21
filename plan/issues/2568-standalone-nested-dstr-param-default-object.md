---
id: 2568
title: "standalone: nested destructuring-param default OBJECT yields 0 — two-level `{ w: {x,y,z} = {…} } = { w: {…} }` reads sentinels in standalone mode"
status: ready
sprint: Backlog
created: 2026-06-21
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: destructuring
goal: standalone-completeness
related: [2545, 2544, 2158]
origin: "2026-06-21 — found by sd-1 while regression-guarding #2545: the host nested-default value flow is correct, but the SAME source returns 0 in standalone mode."
---

# #2568 — standalone nested destructuring-param default object reads sentinels

## Problem

#2545 verified the **host-mode** nested destructuring-param default value flow
is correct. The identical source returns `0` in **standalone** mode (`target:
"standalone"`):

```ts
class C {
  method({ w: { x, y, z } = { x: 4, y: 5, z: 6 } } = { w: { x: 1, y: 2, z: 3 } }): number {
    return x * 100 + y * 10 + z;   // host: 123  standalone: 0
  }
}
new C().method();   // outer default fires
```

Both branches diverge in standalone:
- outer default fires → `0` (expect 123)
- `{ w: undefined }` → inner pattern default fires → `0` (expect 456)

## Scope boundary

A **single-level** standalone object param default works:

```ts
class C { method({ x }: { x: number } = { x: 7 }): number { return x; } }
new C().method();   // standalone: 7  ✓
```

So the gap is specific to the **two-level nested** object default in standalone
mode — the inner object-pattern destructuring of a default object value does not
read the object's fields under the standalone (no-JS-host) object
representation. Likely the nested default object literal is materialized via a
path that the standalone field-read can't index (cf. #2545's host fix went
through the JS-host plain-object machinery; standalone uses a different object
representation).

## Acceptance criteria

- The #2545 repro returns 123 (outer default) and 456 (inner default) in
  `target: "standalone"`.
- No regression in the single-level standalone object-default case.
- Extend `tests/issue-2545-nested-dstr-param-default.test.ts` (or a new
  `tests/issue-2568-*.test.ts`) to cover the standalone lane.

## Notes

Found while closing #2545 (sd-1, 2026-06-21). #2545's regression test is
deliberately host-scoped so it stays green; this issue owns the standalone lane.
Senior-dev / standalone-object-representation focus.
