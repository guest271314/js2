---
id: 1594
title: "AnnexB strict function-code / class name-binding TDZ: ReferenceError not thrown (~100 fails)"
status: backlog
created: 2026-05-24
updated: 2026-05-24
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, annex-b, tdz, strict-mode, let, const
goal: spec-completeness
sprint: Backlog
test262_fail: 100
test262_category: annexB/language/function-code, annexB/language/global-code, language/statements/class
---
# #1594 — AnnexB strict function-code / class name-binding TDZ not throwing ReferenceError

## Problem

**~100 test262 failures** where `assert.throws(ReferenceError, ...)` is expected but the engine succeeds silently (returns 2 on the first assertion).

Two distinct sub-clusters share the same observable failure mode:

### Sub-cluster A — AnnexB strict-mode function declarations (~98 tests)

```
annexB/language/function-code/*   ~53 fails
annexB/language/global-code/*     ~45 fails
```

AnnexB §B.3.3 allows `function` declarations in blocks in sloppy mode. In strict mode, these block-scoped functions should not create the legacy outer binding. The tests check that accessing the legacy outer name throws `ReferenceError` in strict mode — we succeed instead.

Sample:
```
test/annexB/language/function-code/block-decl-func-skip-early-err-in-class-lex.js
  returned 2 — assert #1 at L...: assert.throws(ReferenceError, function() { ... })
```

### Sub-cluster B — class name binding in `extends` expression TDZ (~2 tests, easy win)

```
test/language/statements/class/name-binding/in-extends-expression.js
test/language/statements/class/name-binding/in-extends-expression-grouped.js
  returned 2 — assert #1 at L9: assert.throws(ReferenceError, function() {
    class MyClass extends MyClass { }  // MyClass not in scope in its own extends
  });
```

Spec §15.7.1 ClassDeclaration: the class name binding is added to the class's inner scope **after** evaluating the `extends` clause. Using the class name in the `extends` expression should throw ReferenceError. We appear to install the class name binding before evaluating `extends`.

## Acceptance criteria

### Sub-cluster A
- In strict mode, accessing a block-scoped `function` declaration name from an outer scope throws `ReferenceError` per §B.3.3.1
- ~98 `annexB/language/{function-code,global-code}` tests pass

### Sub-cluster B
- `class X extends X {}` throws `ReferenceError` (class name is in TDZ during `extends` evaluation)
- Both class/name-binding tests pass

## Notes

- Sub-cluster B is a 2-line fix (install class-name binding after extends evaluation, not before). High confidence / easy to isolate.
- Sub-cluster A requires understanding the AnnexB §B.3.3 legacy binding rules and how we implement strict-mode block function declarations. May require a separate approach.
- Consider splitting into #1594A (class-name TDZ, 2 tests, trivial) and #1594B (AnnexB block-fn, ~98 tests, medium) if implementation complexity diverges significantly.

## Sub-cluster B — FIXED (2026-05-27)

Class name in its own `extends` expression is now a TDZ ReferenceError. Both
the declaration path (`compileNestedClassDeclaration`) and the class-expression
path (`compileClassExpression`) statically detect a reference to the class's own
name inside the heritage `extends` clause and emit a real `ReferenceError`
instance via `emitThrowReferenceError` (works in both JS-host and standalone
modes). Previously the declaration path silently swallowed the self-reference
(`class-bodies.ts:147` set `parentClassName = undefined`) and the
class-expression path either succeeded (returning 2) or null-deref'd.

**Files**: `src/codegen/statements/nested-declarations.ts`,
`src/codegen/expressions/new-super.ts`. Tests: `tests/issue-1594b.test.ts`.

**test262 results (verified via `runTest262File`)**:
- `language/statements/class/name-binding/in-extends-expression.js` — pass
- `language/statements/class/name-binding/in-extends-expression-grouped.js` — pass (class-expression path)
- `language/statements/class/name-binding/in-extends-expression-assigned.js` — pass (was a crash; now correct)

Sub-cluster A (AnnexB block-fn legacy hoisting, ~98 fails) remains open and is
escalated to the architect — it is a deep cross-cutting change unrelated to
this fix.
