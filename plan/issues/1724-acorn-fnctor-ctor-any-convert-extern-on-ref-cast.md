---
id: 1724
title: "acorn dogfood: __fnctor_<Ctor>_new emits any.convert_extern on a ref.cast-null struct ref → invalid Wasm"
status: ready
created: 2026-05-29
updated: 2026-05-29
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, type-coercion
language_feature: function-constructors, this-property-assignment, ref-coercion
goal: self-hosting-dogfood
sprint: Backlog
parent: 1711
related: [1690, 1679, 1710, 1284, 1298]
---
# #1724 — acorn functor constructor emits `any.convert_extern` on a non-extern ref → invalid Wasm

## Problem

This is the current top blocker on the acorn dogfood loop (#1710/#1711),
surfaced **behind** the now-fixed #1679 (`new this(...)`) and #1690
(`isInAstralSet` global-index shift). `compile(acorn.mjs)` returns
`success=true` with **0 genuine errors** (471 diagnostics, all TS JS-noise —
see "Not a blocker" below), but the emitted binary **fails
`WebAssembly.compile()`**:

```
WebAssembly.compile(): Compiling function #110:"__fnctor_Parser_new" failed:
  any.convert_extern[0] expected type externref, found ref.cast null of type (ref null 94)
  @+202078
```

The whole acorn surface is gated on this: the dogfood harness skips all 5
runtime-AST-diff fixtures because the binary never validates
(`binaryValidates:false`).

## Root cause (hypothesis — to confirm)

`__fnctor_Parser_new` is the synthetic **function-constructor functor** emitted
by `compileFunctionConstructor` in `src/codegen/expressions/new-super.ts:812+`
(`structName = \`__fnctor_${funcName}\``). The constructor body compiles
acorn's `this.X = …` assignments into `struct.set`s on the `__fnctor_Parser`
struct, and at some point coerces a value to `externref` via
`any.convert_extern`.

`any.convert_extern` requires an **anyref/any-subtype** operand. The validator
reports the operand is instead a `ref.cast null (ref null 94)` — i.e. a value
that has already been cast to a **concrete nullable struct ref** (type index
94), not left as anyref. Emitting `any.convert_extern` directly on a
`(ref null <struct>)` is ill-typed: the correct lowering for ref → externref is
`extern.convert_any` (per CLAUDE.md "Type Coercion" — `ref/ref_null → externref:
extern.convert_any`), OR the value should not have been `ref.cast`-narrowed
before the conversion.

So the defect is a **ref→externref coercion site in the functor-constructor
body** (or a shared `coerceType` path it routes through) that:
  (a) uses `any.convert_extern` where `extern.convert_any` is required, or
  (b) narrows a struct-typed `this.X` value with `ref.cast null` and then feeds
      it to the externref conversion without the round-trip through anyref.

This is the same *family* as #1284 / #1298 (typed struct field ↔ extern
roundtrip), but the trigger is the functor-constructor lowering specifically,
not a general typed-dict path — confirm whether the fix belongs in
`new-super.ts` constructor-body emission or in `type-coercion.ts coerceType`.

## How to reproduce

```bash
# from a worktree branched off origin/main (the harness is in tests/dogfood/)
pnpm run dogfood:acorn
# → compile() success=true, 471 diagnostics; WebAssembly.compile() FAILS with
#   the any.convert_extern[0] error on __fnctor_Parser_new (above).
```

A minimal in-repo reducer is **part of this issue's work**: reduce acorn's
`Parser` static-factory + `this.X = …` body to the smallest function-style
class (promoted into `ctx.classSet` via `Object.defineProperties(prototype,…)`
+ `prototype.X = …`, as #1679 notes) whose `__fnctor_<C>_new` reproduces the
`any.convert_extern` validation failure. Pin it as `tests/issue-1723.test.ts`
(compile + `WebAssembly.compile` must succeed).

## Acceptance criteria

1. `WebAssembly.compile()` of compiled `acorn.mjs` no longer fails on
   `__fnctor_Parser_new` (the harness `binaryValidates` flips to `true`, and
   the run+diff fixtures stop being skipped for this reason).
2. The ref→externref coercion in the functor-constructor body emits a
   well-typed sequence (`extern.convert_any` from anyref, or no spurious
   `ref.cast null` before the conversion).
3. A minimal `tests/issue-1723.test.ts` reproducer compiles AND validates.
4. No regression in the existing function-constructor / `new`-expression
   test262 buckets or `tests/equivalence.test.ts`.

## Classification (per #1711 triage)

- **codegen-acceptance** gap (won't validate) — highest-priority class: it
  blocks ALL downstream runtime-divergence discovery for acorn.
- **Real-world weight: HIGH** — `Parser` construction is acorn's hottest path
  (every `parse()` entry instantiates it via `new this(...)`); nothing in acorn
  runs until this validates.

## Notes / scope

- Out of scope: the 464 `Property 'X' does not exist on type 'Y'` +
  3 `Object is possibly 'undefined'` + 4 misc TS diagnostics — all untyped-JS
  checker noise per #1679/#1690, NOT compile blockers (`success` stays `true`).
- Validator offset `@+202078` and function index `#110` are pin-specific
  (acorn 8.16.0, `tests/dogfood/fixtures/acorn-8.16.0.tgz`); the *symbol*
  `__fnctor_Parser_new` is the stable anchor.
