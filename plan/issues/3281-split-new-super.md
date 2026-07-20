---
id: 3281
title: "refactor: decompose compileNewExpression mega-function (WAVE-C)"
status: done
completed: 2026-07-14
assignee: ttraenkler/Dev-WaveC-New
sprint: 72
priority: high
horizon: l
feasibility: hard
model: opus
type: refactor
subtask_of: 3182
loc-budget-allow:
created: 2026-07-14
---

## Problem

`compileNewExpression` in `src/codegen/expressions/new-super.ts` is a ~3,040-LOC
mega-function (lines 2664–5703). It dispatches `new C(...)` across a long ladder
of constructor kinds: function-expression ctors, native Map/Set/WeakMap,
built-in wrapper/error globals (Promise, Number/String/Boolean, Error family,
AggregateError, SuppressedError, Object, Proxy, Function, Date), TypedArray,
user-defined classes, extern classes, and the indexed builtins
(ArrayBuffer/DataView/Array), plus a dynamic/any fallback.

This is the WAVE-C decomposition front for `new-super.ts` (disjoint from the
`binary-ops.ts` front). Goal: bring `compileNewExpression` under ~1,500 LOC by
lifting cohesive constructor-kind dispatch groups into sibling modules, with
**every slice byte-identity-verified** (prove-emit-identity 39/39 across
gc/standalone/wasi).

## Approach (byte-identity sentinel lift)

The function has a clean two-phase structure:
- **Prologue** (2664–4111): special-form guards keyed off `expr.expression`
  syntax — depend only on `ctx`/`fctx`/`expr` (plus two local closures used
  only in the earliest guards).
- **className resolution** (4113–4161), then **className dispatch** (4162–5702).

Each dispatch group is a self-contained `if (…) { … return … }` block that
either fully handles the ctor (and returns) or does nothing and falls through.
So each group lifts into a helper returning `ValType | null | typeof
NEW_FALLTHROUGH` — a **sentinel** for "not handled". Internal `return`
statements (including nested arrow-closure returns) are left **verbatim**; only
a single `return NEW_FALLTHROUGH` is appended. The call site becomes:

```ts
{
  const r = tryCompileX(ctx, fctx, expr /*, className */);
  if (r !== NEW_FALLTHROUGH) return r;
}
```

Because the emitted `fctx.body` instructions are unchanged and the fall-through
predicates are side-effect-free, the emitted Wasm is byte-identical.

### Slices
- **Slice 1** → `new-builtin-globals.ts`: band 3016–4111 (Promise,
  Number/String/Boolean, Error family, AggregateError, SuppressedError, Object,
  Proxy, Function, Date, TypedArray). ~1,096 LOC. Uses only ctx/fctx/expr.
- **Slice 2** → `new-indexed.ts`: band 5068–5699 (ArrayBuffer, DataView, Array).
  ~632 LOC. Uses className + ctx/fctx/expr. Leaves the final
  `reportError; return null` fallthrough in place.

After both: `compileNewExpression` ≈ 1,312 LOC. Both new modules are <1,500 LOC
(no loc-budget-allow needed).

## Acceptance criteria
- `compileNewExpression` under ~1,500 LOC.
- `prove-emit-identity check` prints IDENTICAL (39/39) after each slice.
- `tsc --noEmit` clean.
- Smoke test added (#2093 gate).

## Result

- **Slice 1** (`new-builtin-globals.ts`, 1,155 LOC): lifted the built-in global
  ctor band (Promise, Number/String/Boolean, Error family, AggregateError,
  SuppressedError, Object, Proxy, Function, Date, TypedArray). Byte-identical.
  compileNewExpression ~3,082 → ~1,994 LOC.
- **Slice 2** (`new-indexed.ts`, 685 LOC): lifted the indexed builtin band
  (ArrayBuffer incl. resizable, DataView, Array). Byte-identical.
  compileNewExpression ~1,994 → **1,357 LOC** (under 1,500 ✓).
- Both slices: `prove-emit-identity check` IDENTICAL across all 39
  gc/standalone/wasi emits; `tsc --noEmit` clean;
  `tests/issue-3281.test.ts` green.
- Exported four band-shared helpers from new-super.ts (`isStringTypedArg`,
  `emitHostTaBufferConstruct`, `hostTaBufferArgSymName`,
  `resolvesToAmbientGlobal`) plus `inferArrayElementType`.
