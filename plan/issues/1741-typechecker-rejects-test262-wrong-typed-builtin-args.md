---
id: 1741
title: "TS type-checker CEs on test262 intentionally-wrong-typed builtin method args"
status: backlog
created: 2026-05-29
updated: 2026-05-29
priority: medium
feasibility: hard
task_type: bugfix
area: checker
language_feature: type-checking
goal: test262-conformance
sprint: Backlog
related: [1740, 1445]
---
# #1741 — type-checker rejects test262 wrong-typed builtin args

## Problem

A large share of `built-ins/{String,Array,Math,Number}/prototype/*` test262
FAILs are **compile errors from our TypeScript type-checker**, not runtime
defects. test262 deliberately passes spec-relevant *wrong-typed* arguments to
builtin methods to exercise the runtime coercion / abrupt-completion paths:

```
Argument of type 'symbol' is not assignable to parameter of type 'number'.
Argument of type 'boolean' is not assignable to parameter of type 'number'.
Argument of type 'null' is not assignable to parameter of type ...
Argument of type '{ valueOf(): number }' is not assignable to parameter ...
Argument of type '1' is not assignable to parameter of type 'never'.
```

These are valid JS — the spec says the method ToNumber/ToString/ToInteger-
coerces the arg at runtime (or throws a *runtime* TypeError, which several
of these tests assert via `assert.throws`). Our pipeline rejects them at
compile time before codegen, so the test can never reach its runtime
assertion.

Observed during the Sprint 57 triage-2 bounded sweep across
String.prototype.{padStart,padEnd,at,repeat}, Array.prototype.{at,fill,
includes}, Math.{expm1,log1p,cbrt} — the dominant non-representation FAIL
bucket in those categories was this type-check CE class (5–15 CEs per
category).

## Root-cause hypothesis

The compiler runs TS semantic diagnostics and treats argument-assignability
errors on builtin lib signatures (lib.es*.d.ts) as hard compile errors. For
test262 (which is spec-conformance JS, not type-checked TS), these
assignability errors on *builtin* method calls should be downgraded — the
runtime path already coerces (e.g. `compileStringIntegerArg` →
ToInteger/ToNumber, #1445 throws the spec TypeError for bigint/symbol). The
test harness (`wrapTest`) or the compile entrypoint could relax
arg-assignability diagnostics for known builtin-method call sites (or test262
mode could compile with `noImplicitAny`/assignability relaxed), letting the
runtime coercion + spec-throw logic decide.

## Scope / caution

This is a checker-policy change with broad blast radius (could mask real user
type errors). Needs an architect call on *where* to relax (test262-mode only?
builtin call sites only? a diagnostic allowlist?) and how to keep it from
weakening normal compile-time safety. Sized hard; not a localized dev fix.

## Acceptance criteria

- test262 builtin-method cases with intentionally-wrong-typed args reach their
  runtime assertion instead of CE-ing.
- Real user-code type errors are NOT masked outside test262 mode.
- Net test262 gain across the String/Array/Number/Math prototype categories.

## Source

Filed from Sprint 57 triage-2 (dev-c) bounded FAIL sweep, 2026-05-29.
