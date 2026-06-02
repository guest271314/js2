---
id: 1594
title: "AnnexB strict function-code / class name-binding TDZ: ReferenceError not thrown (~100 fails)"
status: done
created: 2026-05-24
updated: 2026-05-24
completed: 2026-05-28
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: classes, annex-b, tdz, strict-mode, let, const
goal: spec-completeness
sprint: 56
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

## Investigation 2026-05-27 (dev) — ESCALATED, needs architect spec

Ran the full `annexB/language/{function-code,global-code}` clusters through
`runTest262File` on current main: **pass=108, fail=202, ce=2** (the fail count
is ~2× the issue's ~98 estimate). The dominant failure mode is the **opposite**
of the issue's framing:

- **Sub-cluster A is NOT primarily about strict-mode skipping the legacy
  binding.** The bulk of fails are the *positive* AnnexB cases
  (`*-func-init`, `*-func-update`, `*-existing-*-update`, across
  block/if/switch/try/loop containers) where a block-scoped `function f` with
  **no** conflict *must* create a function-scope (var-like) binding visible
  after the block. We fail these. The `*-skip-early-err*` (conflict) cases
  already **pass** on main.
- Minimal repro:
  ```ts
  function outer(): string {
    let after: any;
    { function f() { return 'decl'; } }
    after = f;           // f IS resolvable (hoisted), but...
    return typeof after; // returns "object", should be "function"
  }
  ```
  So `hoistFunctionDeclarations` (src/codegen/statements/nested-declarations.ts)
  does hoist the block function to function scope, but the **hoisted
  function-value representation reports `typeof` as `"object"` not
  `"function"`**. The root cause is in how block-hoisted function declarations
  are represented as values + the AnnexB legacy-binding wiring across all
  container kinds (if/switch/try/loop) — a deep, cross-cutting change to
  shared function-body/closure codegen, not a scoped fix.

**Recommendation**: split.
- **#1594A (AnnexB legacy block-function hoisting)** — ~202 fails. Needs an
  architect spec: correct §B.3.3.1 FunctionDeclarationInstantiation legacy
  var-binding semantics, including (a) the function-value `typeof` fix for
  block-hoisted decls and (b) the skip-conditions (strict mode + would-be
  early error). Touches `nested-declarations.ts` + closure/function-value
  representation. ESCALATED.
- **#1594B (class-name TDZ in `extends`)** — 2 fails
  (`language/statements/class/name-binding/in-extends-expression{,-grouped}.js`).
  Both still fail on main (we don't throw). Classes compile away with no
  runtime TDZ binding, so the class name referenced in its own `extends` is a
  *statically detectable* TDZ violation; the fix is to detect it (class name
  ∈ identifiers of its own heritage clause) and emit a **runtime
  ReferenceError throw** at the class expression's evaluation point (the test
  wraps it in `assert.throws`, so a compile error would NOT satisfy it).
  Isolable from A; small but not a literal 2-liner.
