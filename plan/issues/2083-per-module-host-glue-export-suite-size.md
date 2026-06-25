---
id: 2083
title: "per-module exported host-glue suite (__call_fn_*, __sget_*, __vec_*) dominates small-binary size and is unstrippable by wasm-opt"
status: done
assignee: ttraenkler/dev-2083
sprint: 66
created: 2026-06-11
updated: 2026-06-25
completed: 2026-06-25
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: performance
area: codegen
language_feature: compiler-internals
goal: performance
related: [1094, 1308]
origin: "2026-06-11 WAT quality review (fable agent): measured on main"
---

# #2083 — one closure triggers the full trampoline export suite

## Problem

A one-closure program (`const c = makeCounter(); c();`) emits 12 exported
helpers — `__call_fn_0/2/3/4`, `__call_fn_method_0..4`, `__is_closure`,
`__vec_len`, `__vec_get` — totaling 2,199 bytes after -O of which user
logic is ~300B; 137 ref.test/ref.cast survive -O, nearly all in
trampolines. `__vec_len`/`__vec_get` are exported even by an arith-only
program with no arrays. Per-shape `__sget_*/__sset_*/__struct_field_names`
add 7 more exports per object shape. Because they're EXPORTS, wasm-opt
cannot strip them.

## Root cause

`src/codegen/index.ts:1442-1494` — emitClosureCallExport{,1,2,3,4} +
emitClosureMethodCallExportN(0..4) fire when ANY closure of arity ≤ N
exists (one closure triggers the whole suite since lower-arity closures
accept dropped extra args); per-shape accessors at index.ts:1715-1872.

## Fix direction

Gate each export on an observed host-boundary escape (closure passed to a
host import / object crossing the boundary) instead of mere existence;
expected 5-10x smaller small modules. Related size lever: #1950
(upstream slug: default-on optimization pipeline).

## Acceptance criteria

- One-closure sample drops to <1KB post-O with no host-callback usage
- All host-interop tests still pass (exports appear when actually needed)

## Dupe check

#1094 (JS-side runtime), #1308 (introduced trampolines), #1888, upstream
#1950 — orthogonal; none gate exports on escape analysis. New.

## Resolution (2026-06-25, dev-2083)

**Verified scope — the `__vec_*` suite leaked into EVERY module.** The
`emitVecAccessExports` gate ended in `ctx.vecTypeMap.size === 0`, a disjunct
that could never be true: `createCodegenContext` (`src/codegen/context/
create-context.ts:259-260`) pre-registers the `externref` + `f64` vec struct
types up front for type-index stability, so the map always has ≥ 2 entries.
A traced arith-only / string-only program (no arrays at all) therefore still
emitted all six vec helpers — `__vec_len`, `__vec_get`, `__is_vec`,
`__vec_mut_supported`, `__vec_push`, `__vec_pop`. Because these are module
EXPORTS (GC roots), wasm-opt cannot DCE them or the ref.test/ref.cast dispatch
bodies they pin.

**Fix (narrow, verified-safe).** Added `ctx.usesVecValue`, flipped true the
first time a *genuine* array-usage site asks `getOrRegisterVecType` for a vec
type (an array literal, array method, for-of over an array, TypedArray, …).
The two pre-registration calls are wrapped in `ctx.suppressVecUsageFlag` so
they do NOT count as usage. The gate's final disjunct is now `!ctx.usesVecValue`.
Correctness preserved: the host runtime guards every `exports.__vec_*` access
with a `typeof === "function"` check (e.g. `runtime.ts:7601`, `:8031`), so the
helpers' absence is safe for array-free modules; any module that materialises
an array (even one used purely internally, or returned across the boundary)
keeps all six exports.

**Size delta (representative small programs, gc target, -O):**

| program | before | after | Δ |
|---|---|---|---|
| arith-only (`for` sum) | 808 B | **80 B** | −90 % |
| string-only (`"a"+"b"`) | ~1,140 B | **120 B** | −89 % |
| one-closure (`makeCounter()`) | 3,095 B | **2,404 B** | −22 % |
| real-array (`[1,2,3]` consumed) | 808 B | 863 B (exports correctly kept) | ✓ |

The one-closure residue is the `__call_fn_*`/`__call_fn_method_*` trampoline
suite, which still fires per the existing per-arity gate — escape-gating those
(the harder direction in "Fix direction" above) is left to a follow-up; this
slice lands the clean, low-risk vec-suite win. Standalone target still emits
the vec suite (the standalone object/iterator runtime satisfies the other gate
disjuncts) — intentionally untouched, as standalone value-rep is owned by a
parallel workstream.

Files: `src/codegen/index.ts` (gate), `src/codegen/registry/types.ts`
(`usesVecValue` flip), `src/codegen/context/{types,create-context}.ts` (flags).
Tests: `tests/issue-2083.test.ts` (export-presence + behavioural invariant).

**This slice implements the `__vec_*` half. The `__call_fn_*` /
`__call_fn_method_*` trampoline suite (the larger residue) is the
whole-program closure-host-escape gate designed below — left as a follow-up,
complementary and non-overlapping with this vec-suite gate.**

---

## Investigation (2026-06-25, dev-2665 — grounded on current main @ 00573c9f1)

### Baseline reproduced

One-closure sample (`.tmp/one-closure.ts`):
```ts
function makeCounter() { let n = 0; return function () { n = n + 1; return n; }; }
const c = makeCounter();
export function test(): number { return c() + c(); }
```
Compiled via `compile()` (unoptimized) → **4207 bytes, 19 internal `__*` exports**
even though the program has NO arrays and never hands `c` to the host:
```
__call_fn_0 __call_fn_1 __call_fn_2 __call_fn_3 __call_fn_4
__call_fn_method_0 __call_fn_method_1 __call_fn_method_2 __call_fn_method_3 __call_fn_method_4 __call_fn_method_5
__is_closure __is_vec __vec_get __vec_len __vec_mut_supported __vec_pop __vec_push __exn_tag
```
The `__call_fn_*` (6) + `__call_fn_method_*` (6) trampoline suite is the bulk;
`__vec_*` appear even with no array. Because they are **exports**, wasm-opt
cannot strip them (confirmed by the issue's -O measurement: 2,199B survive).

### Emission sites (current line numbers — issue's 1442-1494/1715-1872 had drifted)

- Orchestration: `src/codegen/index.ts:1718-1762` — unconditional calls to
  `emitClosureCallExport{,1,2}`, `emitClosureCallExport3/4`,
  `emitClosureMethodCallExportN(0..5)`.
- Gate: `src/codegen/index.ts:3260` `emitClosureCallExportN()` — emits the
  export whenever ANY closure of arity ≤ N exists (loop 3293-3320, early-return
  `if (entries.length === 0) return;` at 3320). One closure ⇒ the whole arity
  ladder fires (lower-arity closures are accepted by every higher dispatcher,
  extra args dropped). `emitClosureMethodCallExportN` at index.ts:3605 mirrors this.
- Per-shape `__sget_*`/`__sset_*`/`__struct_field_names`: `emitStructFieldGetters`
  / `emitStructFieldSetters` (index.ts:2152+/2314+), `emitVecAccessExports`
  (index.ts:1667).

### Root cause

The gate is **existence**, not **escape**: a closure that is only ever called
*locally* (never passed to a host import, never returned to the host) still
emits the entire host-callback trampoline suite. The exports exist solely so the
JS host can re-invoke a Wasm closure it received — a closure reaches JS only by
(a) being returned from an exported fn whose type admits a closure, or (b) being
passed to a host import. If neither happens, the suite is dead but unstrippable.

### Fix design — whole-program closure-host-escape gate (conservative-safe)

Model on `src/codegen/fnctor-escape-gate.ts` (#2660 S1): an inert, frozen-before-
codegen, whole-program AST pass with a **conservative default that PRESERVES the
status quo** (here: keep emitting). New module
`src/codegen/closure-host-escape-gate.ts` computing one boolean
`ctx.anyClosureEscapesToHost`:

- **Escape (emit the suite) if ANY of:**
  1. an exported function's declared return type admits a function/closure or is
     `any`/untyped (host receives a callable it may re-invoke);
  2. a closure value is passed as an argument to a **host import** call
     (Array/Function HOFs lowered to host shims — `map`/`forEach`/`Array.from`/
     `__proto_method_call` — `addEventListener`, `JSON.stringify` replacer, etc.);
  3. a closure is stored on / spread into an object or array that itself escapes
     to the host (returned/passed across the boundary).
- **Conservative default = ESCAPE (keep current behaviour).** Any program the
  analysis cannot prove escape-free keeps the full suite. The only behavioural
  change is: a provably escape-free program (the issue's sample) suppresses
  `__call_fn_*`/`__call_fn_method_*` (and, by the same predicate, the
  host-callback `__vec_*` arms that exist only for host re-entry). Failure mode
  is bounded to "miss a size win" (0 rows), NEVER "drop a needed export" (which
  would silently break host callbacks across the suite — the floor risk).
- Wire `emitClosureCallExportN` / `emitClosureMethodCallExportN` to early-return
  when `!ctx.anyClosureEscapesToHost` (in addition to the existing
  `entries.length === 0`).

Expected: the one-closure sample drops 12 trampoline exports → <1KB post-O (the
acceptance target), while every host-interop test keeps its exports (they all
satisfy the escape predicate).

### Validation plan

Broad-impact, host-ABI change → MUST run the full merge-group/local-ci floor,
NOT a scoped sweep (memory `project_broad_impact_validate_full_ci`): a wrongly-
suppressed export shows up only as a host-callback runtime failure deep in
test262/equivalence, which a scoped probe would miss. Plus a new
`tests/issue-2083.test.ts` asserting (a) the escape-free sample emits none of
`__call_fn_*`, and (b) a `[1,2].map(x=>x*2)`-style sample still emits them.

### Overlap flagged (per coordinator)

- **#2527 (core-wasm linking)** — moving the glue into a shared/imported core
  module is an orthogonal *delivery* mechanism for the same suite; the escape
  gate reduces *what must be emitted/linked* and composes with it (gate first,
  then link the residual). No conflict; sequence gate → link.
- **#2181 (defineBuiltin scaffold)** — adjacent runtime-glue registration. The
  escape gate is a pure emit-time predicate over `ctx.closureInfoByTypeIdx`; it
  does not change how builtins are defined, only whether the host-callback
  trampolines are exported. No source overlap expected.
- **#1094 / #1308 / #1888 / upstream #1950** — orthogonal (issue's dupe check
  holds; none gate exports on escape).

### Status

Baseline + design grounded; implementation is a new whole-program escape pass +
two early-return gates + a new test, validated against the full floor. The
`__vec_*` half of this is already implemented (see Resolution above); the
`__call_fn_*` trampoline escape gate remains the follow-up.
