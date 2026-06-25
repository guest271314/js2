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
