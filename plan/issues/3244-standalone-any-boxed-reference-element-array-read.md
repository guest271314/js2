---
id: 3244
title: "Standalone: any-boxed homogeneous reference-element array reads elements as undefined (index + destructuring)"
status: done
assignee: opus-anycontainer
completed: 2026-07-13
sprint: 71
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen, standalone
language_feature: arrays, any-boxing, destructuring, element-access
goal: standalone-mode
umbrella: 1781
related: [2379, 3059, 2151, 2186, 3132, 1042]
loc-budget-allow:
  - src/codegen/literals.ts
  - src/codegen/object-runtime.ts
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

## Resolution (opus-anycontainer, 2026-07-13)

Root cause was **two separate defects on the standalone lane**, not one. WAT
inspection of `const a: any = [{ x: 777 }]; a[0].x` vs the working
`const o = { x: 777 }; const a: any = [o]; a[0].x` was decisive — the inline
literal built a **null** element, the named-var built a real struct.

**Defect 1 — element read-back (READ time).** `boxVecElementToExternref`
(`src/codegen/object-runtime.ts`) — which `fillExternGetIdxVecArms` uses to box
a typed `__vec_<k>` element as it is read through the externref boundary
(`__extern_get_idx`) — only had arms for `f64` / `i32` / `externref` /
**string-ref** elements. A homogeneous object array is a `__vec_<objStruct>` and
a nested array is a `__vec_<innerVec>`; both have a **general GC struct/array
ref** element, which hit the `return null` fallback → the carrier was skipped →
`__extern_get_idx` answered the null miss → element read back undefined/NaN.
Fix: generalize the string-only ref arm to box **any GC struct/array referent**
via `extern.convert_any` (the universal GC-ref → externref boxing the string arm
already used), guarded to skip **func-typed** referents (`funcref` is not an
`anyref` subtype — converting it is invalid Wasm). This alone flipped nested
arrays, string sub-arrays, and named-object arrays.

**Defect 2 — inline-object-literal carrier mismatch (BUILD time).** An inline
object literal in an `any` / `Array<any>` context is compiled as a **dynamic
`$Object`** (externref), because its contextual type is `any`. But the array's
element carrier is inferred from the literal's *structural* type
(`{ x: number }` → a **closed `__anon_0` struct** → `__vec_<__anon_0>`). The
element store then coerced `$Object → (ref null __anon_0)` via
`any.convert_extern; ref.test; (if … ref.cast (else ref.null))` — the `ref.test`
**fails** ($Object is not the closed struct) → the element was stored as
**NULL**. So `a[0]` was genuinely null and Defect 1's fix could not help.
Fix: extend the existing `#3154`/`#2106 S0` `any`-context element-widening in
`compileArrayLiteral` (`src/codegen/literals.ts`) — which already re-keys numeric
`any[]` elements to an externref carrier — to also fire for **plain object-struct
elements**, so each object is stored by its own dynamic rep (identical to a
heterogeneous `[1, { x: 777 }]` array, which already boxes every element).
Standalone/nativeStrings-gated (the host lane uses `__js_array_new` + real JS
values, already correct); nested-array vec-struct carriers are **excluded**
(they read back fine via Defect 1's typed vec arm).

**Both fixes are standalone-only** — host-lane binaries are byte-identical to
`origin/main` (verified via SHA over the host-lane binary for object-array,
typed-array, class, and object-literal shapes). GC-vs-standalone parity verified
across 13 shapes (index, nested, deep-nested, multi-field, multi-element,
string-field, nested-object-field, typed-then-any, and primitive/string/boolean
controls) — all match host-free. Regression test:
`tests/issue-3244-standalone-any-container-elem-rep.test.ts` (10 cases).

**Flip-ceiling / breadth.** test262 is not checked out locally, so the full
corpus flip-count runs in CI's merge_group standalone floor. Per opus-asyncthen's
#3245 decomposition, #3244 is the **dominant root** of the ~85-file async-gen
dstr host-free-FAIL cluster (nested `[{x}]`, `{ w: {x,y,z} = … }` nested-default
patterns, etc.); the ~30 `notSameValue` files are any-strict-eq (genproto3,
separate), and the ~29 "error-path" files were a mirage that collapse into #3244
(their binding-value assert fails first). Coordinated with **opus-leak3**
(cluster #2, ~925 "Cannot access property on null/undefined") — that cluster is a
DISTINCT root (missing this-brand-check TypeError on TypedArray/ArrayBuffer
prototype accessors), NOT #3244; only a small nested-`results[i][j]` slice
overlaps. Coordinated with **opus-crashes** (`__iterator` plain/user-iterable
dispatch-guard cluster) — also distinct, no src overlap.
