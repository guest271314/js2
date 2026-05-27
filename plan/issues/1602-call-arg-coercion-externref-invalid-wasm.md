---
id: 1602
title: "codegen: call-site argument coercion emits invalid wasm (call expected externref, found f64/other)"
status: done
created: 2026-05-24
updated: 2026-05-24
completed: 2026-05-24
priority: high
feasibility: medium
task_type: bugfix
area: codegen
language_feature: type-coercion, call-expression
goal: compiler-correctness
sprint: 56
es_edition: multi
test262_count: 39
related: [1522]
---
# #1602 — Call-site argument coercion produces invalid wasm

## Problem

39 test262 tests fail with `invalid Wasm binary` where the validator rejects a
`call` op because the argument on the stack has the wrong type for the
callee's signature:

```
call[N] expected type externref, found ... of type f64   (26 cases)
call[N] expected type externref, found ... of type f64   (13 cases, mixed externref/f64)
```

Spread across `language/expressions` (spread-obj-null, dynamic-import LHS),
`built-ins/Object`, `built-ins/Function` (toString of async methods),
`built-ins/Atomics`, `built-ins/RegExp`, `built-ins/Number`,
object method-definition, and `top-level-await` for-of.

This is **distinct from** #1522's `extern.convert_any double-wrap` cluster:
here the failure is at the **`call` op itself** — the argument was never
coerced to the parameter type (an f64 or unboxed value is passed where the
callee declares `externref`), rather than a global being double-wrapped.

## Failing test examples

- `test/language/expressions/new/spread-obj-null.js`
- `test/built-ins/Function/prototype/toString/async-method-class-expression-static.js`
- `test/language/expressions/object/method-definition/generator-length-dflt.js`
- `test/language/module-code/top-level-await/syntax/for-of-await-expr-identifier.js`

## Root-cause hypothesis

The argument-lowering path in call codegen (`src/codegen/expressions.ts` call
emission, `coerceType` in `src/codegen/type-coercion.ts`) skips the
f64→externref / value→externref coercion for certain argument shapes:
spread-into-call, generator/async trampoline params (`__obj_meth_tramp_*`),
and dynamic-import call targets. The callee signature expects `externref` but
the caller leaves the raw f64/value on the stack. Audit the per-argument
coercion to apply `__box_number` / `extern.convert_any` against the resolved
parameter type for these call paths.

## Acceptance criteria

- The four example tests compile to valid Wasm.
- >=30 of the 39 tests move off `compile_error`.

## Root cause & fix (resolved)

Three independent codegen bugs all surfaced as the same validator error
(`call[N] expected externref, found ...`). Fixed:

1. **Stale lifted func index in `new <FunctionExpression>(args)`**
   (`src/codegen/expressions/new-super.ts`, `compileNewFunctionExpression`).
   The constructor `call` used a `liftedFuncIdx` captured at registration
   time, but compiling a spread-object argument (`{...null}` →
   `__new_plain_object`/`__object_assign` late imports) shifts every defined
   function index. The shift machinery patched the already-emitted `ref.func`
   and `funcMap`, but the stale local was used for the `call`, so `call` and
   `ref.func` disagreed. Fix: re-resolve the index from `ctx.funcMap` after
   the arguments are compiled.

2. **Sibling object-literal method collision** (`src/codegen/literals.ts`,
   `compileObjectLiteralForStruct`). `{ *m(x = 42, y) {} }` (params
   `[f64, externref]`) and `{ *m(x, y = 42) {} }` (params `[externref, f64]`)
   structurally dedupe to the same method name and shared one `funcMap`
   entry; the second body-compile overwrote the func type, so the first
   literal's value-closure trampoline forwarded args in the wrong order. The
   per-literal-funcIdx guard (#1557) only fired on a param-*count* mismatch.
   Fix: also treat a same-arity param-*type/order* divergence as a mismatch,
   and seed the fresh per-literal func with a type built from THIS literal's
   params (so a trampoline reading the signature up front sees the right one).

3. **Method-as-closure trampoline body snapshot**
   (`src/codegen/closures.ts`, `emitObjectMethodAsClosure` +
   `finalizeMethodTrampolines`). The trampoline forwarding body is built when
   the method value is accessed, but the method's `func.typeIdx` can be
   refined during its own body compilation. Fix: record each trampoline and
   rebuild its forwarding body against the method's final signature in a
   post-pass after all function bodies are compiled (guarded to same arity so
   the shared wrapper func type's contract is preserved).

**Out of scope (separate feature gap):** `(class { static async f() {} }).f`
— accessing a static method on a class *expression* value yields a bare
`ref.func` (the class constructor) and `.f` is never resolved to the static
method, leaving a funcref uncoerced at the call. This is a missing
class-expression static-member-access path in `property-access.ts`, not a
call-site coercion bug; tracked for a follow-up.

## Follow-up regression (fixed 2026-05-25) — ~245 test262 tests lost

Fix #2 above (the per-literal-funcIdx fork on a same-arity param-*type*
divergence) over-triggered. The pre-pass in `compileObjectLiteralForStruct`
builds the method's **self** param as a non-null `ref structTypeIdx`, but the
actually-compiled method uses `ref null structTypeIdx` for self (and
`ref null U` for any default-initialised ref param). The strict `valTypesMatch`
treats `ref T` and `ref null T` as different, so even the **single-literal
common case** — `{ method([x,y,z] = [1,2,3]) {} }` — was flagged as a
"mismatch" and forked a fresh per-literal func. That orphaned the original
shared `funcMap` entry with an **empty body**. The per-literal map only
redirects the **closure** path (`emitObjectMethodAsClosure`); a **direct**
member call `obj.method()` dispatches via `funcMap`, so it landed on the empty
func, which (combined with a `ref.null … ref.as_non_null` on the defaulted
param) trapped at runtime — `dereferencing a null pointer`.

This regressed **187** `language/expressions/object/dstr/*` + **22**
`.../method-definition/*` tests (object methods with destructured / default
params, invoked directly). Peak 29,603 (sha 65844, PR #593) → 29,355 (sha
9265). Bisected: the probe passes at 65844 and traps at the post-#1602 HEAD.

**Fix:** compare ref/ref_null of the **same struct typeIdx** as equal in the
fork decision (`refTypesMatch` in `literals.ts`). Nullability of the same
struct is not a real signature divergence — WasmGC `ref null T` is a supertype
of `ref T` and the trampoline forwarding is unaffected. Genuine divergence
(`[f64, externref]` vs `[externref, f64]`) differs in `kind`/`typeIdx` and is
still detected, so #1602's Bug B sibling-generator case (covered by
`tests/issue-1602.test.ts`) keeps passing. Regression guard:
`tests/issue-1602-regress-direct-call.test.ts`.
