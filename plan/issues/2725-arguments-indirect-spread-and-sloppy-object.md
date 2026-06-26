---
id: 2725
title: "arguments residual: spread args in indirect/aliased calls + sloppy-mode arguments-object identity (.callee/.constructor/hasOwnProperty)"
status: ready
sprint: Backlog
goal: test262-conformance
feasibility: medium
depends_on: []
priority: medium
es_edition: multi
language_feature: arguments-object
task_type: bug
created: 2026-06-26
updated: 2026-06-26
---
# #2725 — arguments residual: indirect-call spread + sloppy-mode arguments-object identity

Split out from **#2704** (which fixed the dominant case: `arguments.length` /
`arguments[i]` on *non-spread* aliased / indirect method calls — the
multi-funcref dispatch path now plumbs `__argc` / `__extras_argv`). Two distinct
residuals remain, each a separate, deeper change:

## (A) Spread args in an indirect / aliased call (~5 tests)

The **direct** method-call path already handles spread + `arguments.length`
correctly (`obj.m(42, ...[1], ...arr)` → `arguments.length === 4`). The
**indirect** path (`var ref = obj.m; ref(42, ...[1], ...arr)`) does NOT: it
compiles each `expr.arguments[i]` as a plain expression and builds a
compile-time-fixed extras list, so a `SpreadElement` (especially a runtime array
`...arr`) is mis-counted — observed `arguments.length === 3` (want 4),
`arguments[2] === NaN` (want 2).

Fixing this requires the indirect-callable dispatch in
`compileCallExpression` (`src/codegen/expressions/calls.ts`, the
`__callable_param` / multi-funcref branch) to expand spread arguments — building
the args/extras at **runtime** for non-literal spreads and setting `__argc`
from the runtime length, mirroring the direct path's spread machinery.

Failing test262 (baseline 2026-06-26):
```
test/language/arguments-object/async-gen-meth-args-trailing-comma-spread-operator.js
test/language/arguments-object/cls-decl-async-gen-meth-args-trailing-comma-spread-operator.js
test/language/arguments-object/cls-decl-async-gen-meth-static-args-trailing-comma-spread-operator.js
test/language/arguments-object/cls-expr-async-gen-meth-args-trailing-comma-spread-operator.js
test/language/arguments-object/cls-expr-async-gen-meth-static-args-trailing-comma-spread-operator.js
```

## (B) Sloppy-mode arguments-object identity (~7 tests)

The current `arguments` object is a simplified vec-backed value; it does not
expose the real object surface that ES §10.4.4 mandates:
- `arguments.callee` (the executing function object)
- `arguments.constructor` / `arguments.constructor.prototype === Object.prototype`
  (the `[[Prototype]]` is `Object.prototype`)
- `arguments.hasOwnProperty("length")` (own `length` data property)

These probe the arguments object *as a real Object*, so they need the arguments
object to carry an Object prototype + a `callee` slot + own-property semantics —
an arguments-object *representation* change, not the argc plumbing #2704 fixed.

Failing test262 (baseline 2026-06-26):
```
test/language/arguments-object/S10.6_A2.js     (arguments.constructor.prototype === Object.prototype)
test/language/arguments-object/S10.6_A3_T1.js
test/language/arguments-object/S10.6_A3_T4.js
test/language/arguments-object/S10.6_A4.js     (arguments.callee === fn)
test/language/arguments-object/S10.6_A5_T1.js  (arguments.hasOwnProperty("length"))
test/language/arguments-object/S10.6_A5_T3.js
test/language/arguments-object/S10.6_A5_T4.js
```

Related: **#1726** (mapped arguments exotic descriptor semantics, §10.4.4) — (B)
is the unmapped/identity side, distinct from #1726's mapped-descriptor side.

## Acceptance criteria

- (A) the 5 spread tests above flip to pass (indirect-call spread is counted /
  exposed in `arguments` identically to the direct path).
- (B) the 7 `S10.6_*` tests above flip to pass (arguments object exposes
  `callee`, `Object.prototype` chain, and own `length`).
- No regression in `arguments-object/` currently-passing tests. Full CI green.

(A) and (B) are independent; either may be sliced separately.
