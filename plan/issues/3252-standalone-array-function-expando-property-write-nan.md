---
id: 3252
title: "standalone: expando named-property writes on array/function objects don't stick (read back NaN/undefined)"
status: ready
created: 2026-07-13
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
language_feature: exotic-objects
goal: standalone-mode
umbrella: 1781
sprint: Backlog
related: [3246]
es_edition: ES2015
---
# #3252 — standalone array/function expando property writes don't stick

## Problem

Under `--target standalone`, assigning an arbitrary **named** (non-index)
property to an array or function object does not persist — the value reads back
as `NaN` (numeric context) / `undefined`:

```ts
const d: any = [];
d.value = 7;
return d.value;          // => NaN   (expected 7)

const f: any = function () {};
f.value = 8;
return f.value;          // => NaN   (expected 8)
```

Verified on the #3246-inclusive base (2026-07-13).

## Why it matters / how it surfaced

This is the **root** of the array/function-**descriptor** failures seen while
scoping the #3246 ToPropertyDescriptor cluster: `Object.defineProperty(o, k, d)`
where `d` is an **array or function used as the descriptor** (with `d.value` /
`d.enumerable` expando fields) reads those fields back as NaN/undefined, so the
resulting property is wrong:

```ts
const o: any = {};
const d: any = []; d.value = 7; d.enumerable = true;
Object.defineProperty(o, "x", d);
Object.getOwnPropertyDescriptor(o, "x").value;   // NOT 7 (expando lost)
```

So the "array/function descriptor" test262 failures are **downstream of this
expando-storage gap**, NOT a ToPropertyDescriptor parsing bug. They are
therefore split OUT of the Object.create Properties-field slice (#3246
follow-up) into this issue.

## Root direction

Array (`$Vec`) and function (`$Fn`/functor) exotic objects have no
general-purpose `$PropEntry` overlay for arbitrary named own properties in the
standalone value model — writes route to index/element storage (arrays) or are
dropped (functions), and a subsequent named read misses. Needs a named-property
overlay on the array/function carriers (the same per-object property table that
`$Object` uses), or a boxed-wrapper promotion when a named property is assigned.

## Coordination

Related to opus-defineprop2's **array-descriptor-overlay architect epic** (the
`$Vec` has no per-index descriptor storage; verifyProperty needs a coherent
element read/write/gOPD/isWritable overlay). This expando-write gap is the same
missing-overlay substrate viewed from the named-property side — likely folds
into that epic. Cross-ref once its number is posted.

## Scope

- Distinct root from #3246 (ToPropertyDescriptor shape) and from the
  Object.create Properties-field coercion slice. Do NOT bundle.
- Standalone-mode / `host_free_pass`.
- `feasibility: hard` — carrier-representation change; needs architect input,
  likely merged into the array-descriptor-overlay epic.
