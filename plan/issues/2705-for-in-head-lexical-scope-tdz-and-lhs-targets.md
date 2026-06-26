---
id: 2705
title: "for-in: head let/const TDZ, lexical scope open/close, LHS non-simple targets, var-head visibility"
status: ready
sprint: 67
goal: test262-conformance
feasibility: hard
depends_on: []
priority: high
es_edition: ES2015
language_feature: for-in
task_type: bug
created: 2026-06-26
updated: 2026-06-26
---
# #2705 — for-in head lexical scope, TDZ, LHS targets, var visibility

## Problem

The `for (... in ...)` statement has multiple scoping and LHS-target gaps vs ECMAScript §14.7.5:

**(a) Per-iteration lexical binding + TDZ.** `for (let x in obj)` and `for (const x in obj)` must create a fresh lexical binding each iteration with a TDZ entry at the top of each iteration body. Accessing `x` before the binding is initialized should throw a ReferenceError. Tests: `head-let-bound-names-fordecl-tdz`, `head-const-bound-names-fordecl-tdz`, `scope-head-lex-open`, `scope-head-lex-close`, `scope-body-lex-open`, `scope-body-lex-close`.

**(b) LHS that is NOT a simple declaration or plain identifier.** `head-lhs-cover` ("for-in requires a variable declaration or identifier" — the LHS is a CoverParenthesizedExpression/ObjectPattern not yet handled), `head-lhs-let` / `identifier-let-allowed-as-lefthandside-expression-not-strict` ("Cannot read properties of undefined (reading 'name')" — the parser/compiler tries to access `.name` on an undefined node when `let` appears as a plain LHS identifier in non-strict mode). `let-identifier-with-newline` (invalid Wasm binary — line-terminator between `for` and `(let` causing a bad parse path).

**(c) `var`-declared head variable not visible in body or after loop.** `S12.6.4_A3.js`, `S12.6.4_A4.js`, `S12.6.4_A4.1.js`, `S12.6.4_A3.1.js` ("__str is not defined" in both the loop body and after the loop) and `scope-head-var-none.js`, `scope-body-var-none.js` (null_deref) — the `var x` in `for (var x in obj)` is not being hoisted into the enclosing function scope properly, or the code-generated iteration variable has the wrong wasm local slot.

Spec: ECMAScript §14.7.5 (The `for-in` Statement), §14.7.5.6 ForIn/OfHeadEvaluation, §14.7.5.7 ForIn/OfBodyEvaluation.

## Failing tests (test262 baseline 2026-06-26)

### (a) let/const TDZ + lexical scope open/close (~6 tests)

```
test/language/statements/for-in/head-let-bound-names-fordecl-tdz.js
test/language/statements/for-in/head-const-bound-names-fordecl-tdz.js
test/language/statements/for-in/scope-head-lex-open.js
test/language/statements/for-in/scope-head-lex-close.js
test/language/statements/for-in/scope-body-lex-open.js
test/language/statements/for-in/scope-body-lex-close.js
```

### (b) LHS non-simple targets (~3 tests)

```
test/language/statements/for-in/head-lhs-cover.js
test/language/statements/for-in/head-lhs-let.js
test/language/statements/for-in/identifier-let-allowed-as-lefthandside-expression-not-strict.js
test/language/statements/for-in/let-identifier-with-newline.js
```

### (c) var-head visibility in body/after (~6 tests)

```
test/language/statements/for-in/S12.6.4_A3.js
test/language/statements/for-in/S12.6.4_A4.js
test/language/statements/for-in/S12.6.4_A4.1.js
test/language/statements/for-in/S12.6.4_A3.1.js
test/language/statements/for-in/scope-head-var-none.js
test/language/statements/for-in/scope-body-var-none.js
test/language/statements/for-in/head-var-bound-names-in-stmt.js
```

### Additional related tests in this cluster (~3 tests)

```
test/language/statements/for-in/nonstrict-initializer.js
test/annexB/language/statements/for-in/nonstrict-initializer.js
test/language/statements/for-in/resizable-buffer.js
```

Note: `cptn-expr-itr.js`, `cptn-decl-abrupt-empty.js`, `cptn-decl-itr.js`, `cptn-expr-abrupt-empty.js` use `eval()` — deferred (eval is skip-filtered).

## Root cause (suspected)

**(a)** The for-in codegen in `src/codegen/statements.ts` (ForInStatement handler) likely emits the loop binding as a single outer let rather than creating a fresh per-iteration scope. The TDZ guard (ref.is_null + throw) is absent. Fix: wrap each iteration body in a new inner scope where the binding is initialized (see `ForIn/OfBodyEvaluation` step 6.c.iii — CreatePerIterationEnvironment equivalent).

**(b)** The parser/codegen has a special case for `let` as a non-reserved word that appears as a plain identifier in LHS position (non-strict mode). The name resolution path calls `.name` on a node that is `undefined` — needs a guard. `head-lhs-cover` requires recognizing destructuring patterns in for-in heads.

**(c)** The `var` binding in `for (var x in obj)` head is not being added to the enclosing function's variable scope during hoisting, so `x` is local to the loop block and not visible outside. The fix is to ensure `var` in a for-in head is declared at function scope.

This is marked `feasibility: hard` because (a) requires per-iteration environment creation which is a structural change to how the for-in loop is lowered, and (b) requires understanding `let`-as-identifier ambiguity in the grammar.

## Acceptance criteria

At least 18 of the 20 closeable listed tests (excluding eval-based and resizable-buffer) flip from fail to pass. No regression in `statements/for-in/` currently-passing tests. Full CI green.

## Notes

- The architect should spec the per-iteration scope mechanism carefully — particularly how the wasm locals for the binding are cloned per iteration without an allocation.
- See also #2706 (for-in enumeration order — a separate issue on the enumeration algorithm, not scoping).
- `resizable-buffer.js` ("ctors is not defined") is TypedArray-related and out of scope for this issue.
