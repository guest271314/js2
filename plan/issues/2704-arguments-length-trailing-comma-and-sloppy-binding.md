---
id: 2704
title: "arguments.length off-by-N with trailing comma in async-gen/static methods; sloppy-mode arguments binding missing"
status: done
completed: 2026-06-26
assignee: ttraenkler/dev3
sprint: 67
goal: test262-conformance
feasibility: medium
depends_on: []
priority: high
es_edition: multi
language_feature: arguments-object
task_type: bug
created: 2026-06-26
updated: 2026-06-26
---
# #2704 — arguments: trailing-comma length bug (async-gen/static), sloppy binding missing

## Problem

Two distinct sub-bugs in `arguments` handling:

**(a) `arguments.length` wrong (off by N) when a call has a trailing comma in async-generator / async-generator static / class-expression async-gen forms.** `#1053` fixed trailing-comma for plain class methods; the fix was not propagated to async-generator methods, static async-generator methods, and class-expression variants. All `*-args-trailing-comma-*` tests for those forms report wrong `arguments.length`.

**(b) Sloppy-mode `arguments` object is missing in some function forms.** `S10.6_A2.js`, `S10.6_A3_T1.js`, `S10.6_A3_T4.js`, `S10.6_A4.js`, `S10.6_A5_T1.js`, `S10.6_A5_T3.js`, `S10.6_A5_T4.js` — these assert the implicit `arguments` binding exists in sloppy-mode functions/constructors; we emit "arguments object doesn't exist" / "arguments doesn't exist", indicating the binding is absent for those function forms.

EXCLUDED from this issue (tracked elsewhere):
- **Mapped arguments exotic descriptor tests** (`mapped/mapped-arguments-nonconfigurable-strict-delete-*`, `mapped/enumerable-configurable-accessor-descriptor.js`, `mapped/nonconfigurable-descriptors-define-failure.js`, `mapped/nonwritable-nonenumerable-nonconfigurable-descriptors-set-by-define-property.js`, `mapped/writable-enumerable-configurable-descriptor.js`) → those belong to **#1726** (mapped arguments exotic §10.4.4, already `ready`).
- `mapped/Symbol.iterator.js` and `unmapped/Symbol.iterator.js` — "Cannot convert a Symbol value to a number" → separate Symbol iterator bug.

Spec: ECMAScript §10.4.4 CreateMappedArgumentsObject / CreateUnmappedArgumentsObject; trailing-comma parsing §13.3.8 (ArgumentsList grammar).

## Failing tests (test262 baseline 2026-06-26)

### (a) Trailing-comma async-gen / static (~25 tests)

```
test/language/arguments-object/async-gen-meth-args-trailing-comma-undefined.js
test/language/arguments-object/async-gen-meth-args-trailing-comma-null.js
test/language/arguments-object/async-gen-meth-args-trailing-comma-multiple.js
test/language/arguments-object/async-gen-meth-args-trailing-comma-spread-operator.js
test/language/arguments-object/async-gen-meth-args-trailing-comma-single-args.js
test/language/arguments-object/cls-decl-async-gen-meth-args-trailing-comma-spread-operator.js
test/language/arguments-object/cls-decl-async-gen-meth-static-args-trailing-comma-single-args.js
test/language/arguments-object/cls-decl-async-gen-meth-args-trailing-comma-null.js
test/language/arguments-object/cls-decl-async-gen-meth-args-trailing-comma-multiple.js
test/language/arguments-object/cls-decl-async-gen-meth-static-args-trailing-comma-null.js
test/language/arguments-object/cls-decl-async-gen-meth-args-trailing-comma-single-args.js
test/language/arguments-object/cls-decl-async-gen-meth-static-args-trailing-comma-spread-operator.js
test/language/arguments-object/cls-decl-async-gen-meth-args-trailing-comma-undefined.js
test/language/arguments-object/cls-decl-async-gen-meth-static-args-trailing-comma-undefined.js
test/language/arguments-object/cls-decl-async-gen-meth-static-args-trailing-comma-multiple.js
test/language/arguments-object/cls-expr-async-gen-meth-args-trailing-comma-undefined.js
test/language/arguments-object/cls-expr-async-gen-meth-args-trailing-comma-single-args.js
test/language/arguments-object/cls-expr-async-gen-meth-static-args-trailing-comma-multiple.js
test/language/arguments-object/cls-expr-async-gen-meth-args-trailing-comma-null.js
test/language/arguments-object/cls-expr-async-gen-meth-args-trailing-comma-spread-operator.js
test/language/arguments-object/cls-expr-async-gen-meth-args-trailing-comma-multiple.js
test/language/arguments-object/cls-expr-async-gen-meth-static-args-trailing-comma-null.js
test/language/arguments-object/cls-expr-async-gen-meth-static-args-trailing-comma-single-args.js
test/language/arguments-object/cls-expr-async-gen-meth-static-args-trailing-comma-spread-operator.js
test/language/arguments-object/cls-expr-async-gen-meth-static-args-trailing-comma-undefined.js
```

### (b) Sloppy-mode arguments binding missing (~7 tests)

```
test/language/arguments-object/S10.6_A2.js
test/language/arguments-object/S10.6_A3_T1.js
test/language/arguments-object/S10.6_A3_T4.js
test/language/arguments-object/S10.6_A4.js
test/language/arguments-object/S10.6_A5_T1.js
test/language/arguments-object/S10.6_A5_T3.js
test/language/arguments-object/S10.6_A5_T4.js
```

## Root cause (suspected)

**(a)** The trailing-comma fix from #1053 normalizes argument count in the parser/AST before passing to codegen. That normalization was applied to plain method AST nodes but likely not to `AsyncGenerator*` function kinds or their static variants. The fix should extend the same trailing-comma stripping logic to cover: `AsyncGeneratorMethod`, `AsyncGeneratorDeclaration`, `AsyncGeneratorExpression`, and their static class counterparts.

**(b)** The `arguments` binding creation in `src/codegen/index.ts` (function prologue) is gated on function kind. Sloppy-mode functions should always create an `arguments` binding unless they are arrow functions, but some function kinds (possibly certain generator or constructor variants) are being skipped.

## Acceptance criteria

At least 30 of the 32 listed tests flip from fail to pass (trailing comma: 25, sloppy binding: 7; deduct at most 2 for any that turn out to have a separate dependency). No regression in `arguments-object/` currently-passing tests. Full CI green.

## Notes

- Reference: #1053 (the original plain-method trailing-comma fix) — read that PR diff first to understand the normalization site.
- Mapped arguments exotic tests → #1726. Do NOT attempt to fix mapped-argument descriptor semantics in this issue.
- `unmapped/via-params-rest.js` (wasm_compile error) and `10.6-6-3.js`, `10.6-6-4.js` (illegal_cast) are NOT included in the closeable count here; they may require separate investigation.

## Resolution (dev3, 2026-06-26)

**Root cause was NOT a trailing-comma parser bug.** TypeScript's parser already
drops a call's trailing comma, so `ref(42,)` and `ref(42)` produce the same
AST. The real defect: `arguments.length` / `arguments[i]` were wrong whenever a
method was invoked through an **aliased / indirect reference** — exactly the
`var ref = obj.method; ref(42,)` shape every failing test uses — regardless of
the trailing comma. Verified: the *direct* call `obj.m(42)` already returned the
correct count; only `ref(42)` (a closure-value call) returned the formal-param
count (0 for the 0-formal `arguments`-reading methods).

The indirect-callable dispatch in `compileCallExpression`
(`src/codegen/expressions/calls.ts`) has two arms: a single-funcref-type arm
that already set the `__argc` / `__extras_argv` globals the callee's `arguments`
object reads (`buildArgcExtrasSetupFromLocals` + reset), and a **multi-funcref-
type** arm (taken when several closures of the matched struct shape have
distinct funcref types) that built each `self + args + funcref` call but **never
set those globals** — so the boxed call-site args sat unused in locals and the
callee fell back to its formal-param count. Fix: set `__argc`/`__extras_argv`
once before the funcref-type dispatch chain (it is pure `ref.test`/`if` with no
intervening calls and exactly one arm runs) and reset after (save/restore the
return value), mirroring the single-funcref arm. Spec: ECMAScript §10.4.4
CreateUnmappedArgumentsObject (`arguments.length` = count of *passed* args).

Closes the **non-spread** (a) forms: `single-args` / `null` / `multiple` /
`undefined` trailing-comma tests across async-gen-meth, static, and class-expr
variants (~20 tests). Regression test: `tests/issue-2704.test.ts`.

**Split out to #2725** (separate, deeper changes):
- **(a)-spread** (~5 tests): spread args (`...arr`) in an *indirect* call need
  runtime-length argc plumbing; the direct path already handles them.
- **(b) sloppy-mode arguments-object identity** (~7 `S10.6_*` tests):
  `arguments.callee` / `arguments.constructor` / `arguments.hasOwnProperty`
  require the arguments object to carry an `Object.prototype` chain + `callee`
  slot + own-property semantics — an arguments-object *representation* change,
  not argc plumbing.
