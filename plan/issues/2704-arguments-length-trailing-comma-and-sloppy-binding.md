---
id: 2704
title: "arguments.length off-by-N with trailing comma in async-gen/static methods; sloppy-mode arguments binding missing"
status: ready
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
