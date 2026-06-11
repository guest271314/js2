---
id: 2076
title: "standalone: Object.assign drops later sources entirely — native __object_assign never iterates the sources vec"
status: ready
sprint: 61
created: 2026-06-11
updated: 2026-06-11
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: objects
goal: host-independence
related: [2046, 2009]
origin: "2026-06-11 standalone spec audit (fable agent): verified on main @ 6bf881a0c, target standalone"
---

# #2076 — only the target survives assign

## Problem

```ts
const t: any = Object.assign({a:1}, {b:2, a:3});
t.a + "," + t.b
// standalone: "1,0" (second source never applied; missing prop reads 0)
// node: "3,2"
```

## Root cause

`src/codegen/object-runtime.ts:2972-3130` — a native `__object_assign`
exists but the sources `$ObjVec` isn't populated or iterated; only the
target survives.

## Fix direction

Populate the sources vec at the call site and iterate it in
`__object_assign` (own enumerable props, later sources override, spec
§20.1.2.1). Distinct from the host-mode field-name collision (#2009).

## Acceptance criteria

- Repro returns "3,2" standalone; multi-source order honored
- Host mode unchanged

## Dupe check

#1905 (Reflect/Object subset), #2046 (standalone Reflect gaps) — neither
claims assign merge. New.
