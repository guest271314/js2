---
id: 1682
title: "Derived constructor must call super() for builtin subclasses (WeakMap/Promise/Object) — missing ReferenceError"
status: done
created: 2026-05-27
updated: 2026-05-27
completed: 2026-05-27
priority: medium
feasibility: easy
reasoning_effort: low
task_type: fix
area: codegen
language_feature: classes/super
sprint: 55
related: [1594, 1551]
---
## Problem

Found by **dev-1607** during a language/class investigation (task #108 probe).
~4 RUNFAIL tests in the sample where a derived constructor of a builtin class
(`WeakMap`, `Promise`, `Object`) omits the required `super(...)` call yet does
not throw.

```js
class C extends WeakMap {
  constructor() {
    // no super() — `this` is never initialized
  }
}
new C();   // expected: ReferenceError; actual: silently returns an instance
```

Per ECMA-262 §10.2.2 (ConstructorEvaluation), a derived class constructor's
`this` binding is uninitialized until `super(...)` runs. When the constructor
returns (and does not return an object), `GetThisBinding` throws a
`ReferenceError`. The compiler previously ran the super-less constructor body
and returned the un-super'd `__self`, so `new C()` succeeded instead of throwing.

## Fix

`src/codegen/class-bodies.ts` — after compiling an explicit derived
constructor body, statically scan it for any `super(...)` call
(`constructorCallsSuper`, which does not descend into nested
functions/arrows/classes that rebind `this`). If a derived constructor contains
no `super(...)` call anywhere, it can never initialize `this`, so we emit the
spec `ReferenceError` via `emitThrowReferenceError` after the body. This is a
sound static under-approximation: absence of any `super` syntax guarantees
`this` is uninitialized at every exit.

Scoped to derived constructors (`fctx.isDerivedConstructor`) with an explicit
ctor body. Base-class constructors and constructors that do call `super()`
(including externref-backed builtin subclasses and user-class chains) are
unaffected.

## Acceptance criteria

- `class C extends WeakMap { constructor() {} }; new C()` throws ReferenceError.
- Same for `extends Promise` and `extends Object`.
- A super-less body with other statements still throws.
- `class C extends WeakMap { constructor() { super(); } }; new C()` constructs
  the instance without throwing.

Verified by `tests/issue-1682.test.ts` (5 cases, all passing).
