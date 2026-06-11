---
id: 2080
title: "standalone: any-boxed empty string is truthy — anyref truthiness checks ref non-null, never string length"
status: ready
sprint: 61
created: 2026-06-11
updated: 2026-06-11
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: host-independence
related: [2072]
origin: "2026-06-11 standalone spec audit (fable agent): verified on main @ 6bf881a0c, target standalone"
---

# #2080 — ToBoolean("") via anyref returns true

## Problem

```ts
const v: any = "";
v ? "T" : "F"
// standalone: "T"   node: "F"
```

Direct `const s = ""; s ? …` is correct — only the any-boxed path is
wrong (flips index 3 of the `[0,-0,NaN,"",null,undefined]` truthiness
table).

## Root cause

anyref truthiness in `src/codegen/type-coercion.ts` checks ref
non-nullness for boxed strings but never the string length (§7.1.2: empty
string → false). Exact line not pinned — locate the anyref ToBoolean
branch.

## Acceptance criteria

- Repro returns "F" standalone; full truthiness table matches Node for
  any-boxed values; direct paths unchanged

## Dupe check

#171 (old boolean edges, done); no standalone truthiness issue. New.
