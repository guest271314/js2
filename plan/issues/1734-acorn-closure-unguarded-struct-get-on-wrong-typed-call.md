---
id: 1734
title: "acorn dogfood: __closure_11 emits unguarded struct.get on a call result of the wrong struct type → invalid Wasm"
status: ready
created: 2026-05-30
updated: 2026-05-30
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, property-access, closures
language_feature: closures, property-access, struct-ref-dispatch
goal: self-hosting-dogfood
sprint: Backlog
parent: 1711
related: [1725, 1710, 778, 1364b]
---
# #1731 — acorn closure emits unguarded `struct.get` on a wrong-typed call result → invalid Wasm

## Problem

After #1725 fixed `__fnctor_Parser_new`, the next acorn dogfood blocker
(`pnpm run dogfood:acorn`) is:

```
WebAssembly.compile(): Compiling function #111:"__closure_11" failed:
  struct.get[0] expected type (ref null 45), found call of type (ref null 94)
  @+203647
```

`compile(acorn.mjs)` still returns `success=true`; the binary fails
`WebAssembly.compile()`, so all 5 runtime-AST-diff fixtures stay skipped.

## Root cause (confirmed via WAT diff)

`__closure_11`'s body reads a property off the result of a function call
(`call 110`) with a **bare, unguarded** `struct.get`:

```wat
;; __closure_11 (WRONG)
local.get 2
local.get 1
call 33
call 110            ;; returns (ref null 94)  ← the actual struct type
struct.get 45 35    ;; ← expects (ref null 45); operand is (ref null 94) → INVALID
```

The sibling closure `__closure_13` reads the **same** `call 110` result
**correctly** — with a `ref.test`-guarded cast first:

```wat
;; __closure_13 (CORRECT)
call 110
local.tee 5
ref.test (ref 45)
(if (result (ref null 45))
  (then local.get 5  ref.cast null (ref null 45))
  (else ref.null 45))
ref.as_non_null
local.set 4
```

So the defect is in the **property-access codegen** for a receiver that is a
**call expression**: when the call's compile-time return type resolves to
struct type 45 but the *emitted* call (`call 110`) actually produces a
**different/wider struct** (type 94), the read path emits an unguarded
`struct.get 45 <field>` instead of the guarded `ref.test → ref.cast → struct.get`
(or multi-struct dispatch) that `__closure_13` uses. The two static types
disagree, so this is a **Wasm validation** failure (not a runtime
illegal-cast trap) — the same *family* as #778 ("always use multi-struct
dispatch to avoid illegal cast traps") but on the call-receiver path, and
specifically inside a lifted closure body.

## Hypotheses to confirm during fix

- The receiver-type resolution for a `CallExpression.property` picks the TS
  declared return type (→ struct 45) and treats it as provably-exact, so the
  property-read fast path emits a bare `struct.get` without the guarded cast.
  `__closure_13` reaches the guarded path because it binds the call result to a
  `(ref null 45)` local first (the decl/`local.tee` path), which forces the
  guarded cast; `__closure_11` consumes the call result inline.
- Likely site: the property-access `objResult.kind === "ref"` / "exact struct"
  branch in `src/codegen/property-access.ts` (the `compilePropertyAccess`
  struct-field path, ~L2422–2462 area) — when the receiver is a call whose
  emitted return type can differ from the resolved struct, route through
  `emitNullGuardedStructGet` / the guarded-cast path instead of a bare
  `struct.get`.

## How to reproduce

```bash
# worktree branched off origin/main (>= 5ac9203c4, includes the #1725 fix)
pnpm run dogfood:acorn
# → compile() success=true; WebAssembly.compile() FAILS on
#   __closure_11 struct.get[0] expected (ref null 45), found call of (ref null 94).
```

A minimal in-repo reducer is part of this issue's work: a closure that reads
`f().prop` where `f`'s return type resolves to struct A but the emitted call
returns struct B (e.g. a function-constructor/closure whose return widens).
Pin it as `tests/issue-1731.test.ts` (compile + `WebAssembly.compile` succeed).

## Acceptance criteria

1. `WebAssembly.compile()` of compiled `acorn.mjs` no longer fails on
   `__closure_11` (binary advances to the next blocker, if any, on the dogfood
   harness).
2. The closure's property read on a call result emits a well-typed sequence —
   the `ref.test`-guarded cast (mirroring `__closure_13`) or multi-struct
   dispatch — never a bare `struct.get` on a possibly-wrong struct type.
3. A minimal `tests/issue-1731.test.ts` reducer compiles AND validates.
4. No regression in closure / property-access / `new`-expression buckets or
   `tests/equivalence.test.ts`.

## Notes / scope

- Validator offset `@+203647` and function index `#111` are pin-specific
  (acorn 8.16.0); the *symbol* `__closure_11` + the
  `struct.get expected (ref null 45) found call of (ref null 94)` shape are the
  stable anchors.
- **Coordination**: this touches struct.get / property-access ref-dispatch
  lowering, which overlaps the CPR cluster and the #1584 (a5) ref-coercion
  migration. Ping the tech lead before editing shared property-access lowering
  broadly; keep the fix scoped to the call-receiver guarded-read path.

## Investigation notes (2026-05-30, where to resume)

Ruled OUT (these property-access struct-field paths are already guarded —
they route a `ref`/`ref_null` receiver through `emitNullGuardedStructGet`
and only emit a bare `struct.get` in the null/VOID `else`):
- `compilePropertyAccess` main struct-field branch, property-access.ts
  ~L2422–2462.
- The second struct-field branch ~L2655–2684.
- The `#1118` object-literal method-as-closure-field path ~L2332–2340 — added
  a `DBG1734` probe at L2336; it did **not** fire for the acorn build, so this
  is not the site.

The `__closure_11` receiver chain is `call 33 ; call 110 ; struct.get 45 35`
— i.e. the property is read off the result of a **method/closure call**
(`X.method()…` or a lifted-closure call), so the producing path is one that
compiles a *call-expression* receiver and trusts its resolved struct type
without the guarded cast. Candidate next sites to instrument (bare
`op: "struct.get"` emits in property-access.ts not yet ruled out):
L857, L911, L1050, L1926/1954/2005/2033/2040/2058 (vec-length, unlikely),
L2209, L2336 (ruled out), L2682 (ruled out). Most likely: a call-result
`.field` fast path that resolves the receiver type from the call's TS return
type and emits `struct.get` directly. The minimal-loss instrumentation: wrap
EVERY `fctx.body.push({op:"struct.get",…})` in property-access.ts behind a
`DBG1734` that prints `propName`/`structTypeIdx` and compares against the
preceding producer's reported type, then re-run `DBG1734=1 dogfood:acorn`
to find the `struct.get 45 …` emit whose receiver is a call returning a
different struct type.

**Fix shape (once site is pinned):** route the call-result receiver through
the same `ref.test`-guarded cast / `emitNullGuardedStructGet` path that the
sibling closures (`__closure_13`) already use, instead of a bare `struct.get`.
Keep scoped to the call-receiver guarded-read path; ping tech lead before
broadening to shared property-access lowering (CPR + #1584 a5 overlap).

**Coordination state:** lead authorized taking this directly (2026-05-30).
Branch `issue-1731-closure-struct-typeconfusion` holds this issue file only
(no source changes yet). The #1725 fix it builds on is merged (main 5ac9203c4).
