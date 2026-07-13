---
id: 3244
title: "Standalone: any-boxed homogeneous reference-element array reads elements as undefined (index + destructuring)"
status: ready
sprint: current
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, standalone
language_feature: arrays, any-boxing, destructuring, element-access
goal: standalone-mode
umbrella: 1781
related: [2379, 3059, 2151, 2186, 3132, 1042]
created: 2026-07-13
origin: "opus-asyncthen bucket-2 diagnosis of async-gen dstr host-free fails — the nested-`[{x}]` destructure-null trap drilled to a broader any-container element-rep substrate bug affecting plain index access too. opus-anyrecv confirmed NOT method-dispatch (their #3237); it is value-representation (#2379/#3059 family)."
---

# #3244 — standalone any-boxed reference-element array reads elements as undefined

## Problem (verified against origin/main @ 503b64ac35, 2026-07-13)

Under `--target standalone`, reading an element of a **homogeneous
reference-element array** (elements are objects, or nested arrays) returns
`undefined`/`NaN`/empty-object when the array crosses an `any` / externref
boundary. Affects **plain index access**, not just destructuring — so it is a
value-representation substrate bug, not a destructuring-lowering bug.

Probes (all correct on gc host lane, wrong on standalone — `.tmp/anyarr.mts`,
`.tmp/elemtypes.mts`, `.tmp/index-vs-dstr.mts`, `.tmp/nullcheck.mts`):

```ts
function f(a: any): number { return a[0].x; }
f([{ x: 777 }]);              // gc 777, standalone NaN

const a: any = [{ x: 777 }];
a[0].x;                        // gc 777, standalone `[Object: null prototype] {}`

function g(a: any): number { return a[0][1]; }
g([[10, 20, 30]]);            // gc 20, standalone NaN

function h([e]: any) { return e; }
h([{ x: 777 }]);              // gc {x:777}, standalone undefined
function k([{ x }]) { return x; }
k([{ x: 777 }]);              // TRAPS "Cannot destructure 'null' or 'undefined'"
```

### What works (bounds the trigger)

- **Primitive-element arrays** (`[5]`, `["a"]`) — correct both lanes.
- **Heterogeneous arrays** (`[1, { x: 777 }]`) — correct both lanes (every
  element boxed to externref → `__vec_externref`).
- **Typed receivers** (`const [e] = arr`, no `any` boxing) — correct.

Only a **homogeneous reference-element** array (which compiles to a *typed
object-vec* / nested-array-vec) boxed to `any`/externref loses its elements.

## Root-cause hypothesis

A homogeneous-object / homogeneous-nested-array literal compiles to a **typed
element-vec** (element type = the object struct / inner vec), not
`__vec_externref`. When boxed to externref (crossing an `any` boundary — param,
`any` local, or the destructure-param `externref → __vec_externref` conversion
at `destructuring-params.ts:1249`), the standalone element read-back path does
not **unbox the typed-vec element** to the uniform any/externref rep. Index
access returns a wrong-typed slot / null; the destructure path's inner
object-pattern then sees the element as null → the "Cannot destructure null"
throw. Fix the boxed-typed-vec element read-back once at the rep boundary and
both index access and destructuring flip together.

Family: #2379 (boxed-any elem rep), #3059 (vec-any-receiver sidecar identity),
#2151 (any-receiver dispatch). **opus-anyrecv confirmed it is NOT method
dispatch (#3237) — it is value-representation, and they will not adopt it.**

## Why it matters (floor lever)

This is the **dominant root** of the async-gen dstr host-free-FAIL cluster
(#3132 follow-up). Most of those files compile host-free but fail at runtime
because the async-gen param is `any`-boxed and its object/array elements read
back undefined (nested `[{x}]`, object-property nested-defaults `{ w: {x,y,z} =
… }`, etc.). Fixing #3244 flips the bulk of that cluster host-free-PASS
(import-independent). See #3245 for the full cluster decomposition.

## Acceptance criteria

1. The probe programs return correct values host-free on standalone (identical
   to gc): `a[0].x` → 777; nested `a[0][1]` → 20; `[e]`/`[{x}]` binds the object.
2. No gc-lane regression (typed-receiver element access byte-identical).
3. Full merge_group standalone floor (broad-impact — any-container rep, never
   scoped). The async-gen dstr nested-pattern cluster flips host-free-fail → pass.

## Repros

`/workspace/.claude/worktrees/*/.tmp/`: `anyarr.mts`, `elemtypes.mts`,
`index-vs-dstr.mts`, `nullcheck.mts`, `bugB.mts`, `bugB2.mts`.
