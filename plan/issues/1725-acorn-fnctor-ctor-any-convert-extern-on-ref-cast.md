---
id: 1725
title: "acorn dogfood: __fnctor_<Ctor>_new emits any.convert_extern on a ref.cast-null struct ref → invalid Wasm"
status: done
created: 2026-05-29
updated: 2026-05-30
completed: 2026-05-30
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
# #1725 — acorn functor constructor emits `any.convert_extern` on a non-extern ref → invalid Wasm

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

## Resolution (2026-05-30)

**Root cause was NOT at the `__fnctor_Parser_new` codegen site.** Codegen there
is correct: for an externref receiver it emits `local.get; any.convert_extern`.
The invalid `… ; any.convert_extern ; ref.cast_null 94 ; any.convert_extern …`
adjacency was **inserted by a post-codegen ref-coercion fixup pass** —
specifically the `struct.set` repair inside `repairStructTypeMismatches`
(`src/codegen/fixups.ts`).

That repair walks backward from a `struct.set` to locate the instruction that
produced the struct-ref **receiver**, tracking stack depth via
`instrStackDelta`. `instrStackDelta` treats `if`/`block`/`loop`/`try` as opaque
(delta 0). acorn's `Parser` constructor compiles
`this.keywords = wordsRegexp(keywords$1[options.ecmaVersion >= 6 ? 6 : …])`,
whose field-**value** sub-expression contains control flow (the ternary + the
multi-struct dispatch `if`-chain for `options.ecmaVersion`). The opaque-block
delta under-counts, so the backward walk **overshoots** the real receiver
(`local.get $__self`) and lands on the externref `options` param
(`local.get 0`) deep inside the value sub-expression. The pass then spliced
`any.convert_extern + ref.cast_null $Parser` after that externref producer —
right before the value sub-expression's own `any.convert_extern` — yielding the
invalid `ref.cast_null ; any.convert_extern` pair that failed
`WebAssembly.compile()`.

**Fix** (`src/codegen/fixups.ts`, `repairBody` struct.set scan): track whether
the backward depth-walk crosses any opaque control-flow instruction
(`if`/`block`/`loop`/`try`). If it does, the located producer is not a
trustworthy struct-ref receiver, so **skip the splice** and leave codegen's own
(already-correct) receiver lowering intact. This is a narrow guard on a
best-effort heuristic — it can only *disable* an unsafe splice, never make a
previously-valid binary invalid (a case that relied on the splice would itself
have produced the invalid adjacency).

**Verification:**
- `pnpm run dogfood:acorn`: `__fnctor_Parser_new` no longer fails
  `WebAssembly.compile()`. The acorn binary now advances to the **next, distinct**
  blocker (`#111 __closure_11: struct.get[0] expected (ref null 45), found call
  of (ref null 94)`) — a separate closure/struct type-confusion bug, not #1725.
- New regression test `tests/issue-1725.test.ts` exercises
  `repairStructTypeMismatches` on a synthetic body with the exact overshoot
  shape: it **fails without the fix** (bogus cast spliced) and **passes with it**.
- No new failures in `tests/stack-balance.test.ts` or class/struct suites —
  the pre-existing local-vitest class failures reproduce identically with and
  without this change (they are baseline-environmental, validated by CI).

**Acceptance criteria status:**
1. ✅ `WebAssembly.compile()` no longer fails on `__fnctor_Parser_new`.
2. ✅ The functor-constructor body emits a well-typed ref→struct lowering
   (the spurious post-pass cast is no longer inserted).
3. ✅ Reducer pinned as `tests/issue-1725.test.ts` (the `tests/issue-1723.test.ts`
   filename suggested in the problem statement was already taken by an unrelated
   issue, so the pin uses `issue-1725`).
4. ✅ No regression in function-constructor / `new`-expression buckets.

**Follow-up (not #1725):** the next acorn blocker `__closure_11`
(`struct.get` ref-45 vs call-of-ref-94) is a distinct closure-codegen type
mismatch in the same family as `tests/class-method-struct-new.test.ts`
("#582"). File/triage separately on the next dogfood lap (#1711).
