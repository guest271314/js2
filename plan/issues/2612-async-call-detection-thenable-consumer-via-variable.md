---
id: 2612
title: "async fn consumed as thenable via variable/expression binding not wrapped in Promise (~18 fails)"
status: ready
created: 2026-06-22
updated: 2026-06-22
priority: high
feasibility: medium
task_type: bug
area: async, codegen
language_feature: async
goal: async-model
sprint: 65
parent: 1042
note: "Re-measured 2026-06-22 (arch, ASYNC lane). Bounded detection bug, NOT the CPS epic. Legacy synchronous-async path works for 76.6% of the async cluster; this is one of the discrete residual buckets."
---
# #2612 — async fn assigned to a variable/expression, consumed via `.then`, isn't Promise-wrapped

## Re-measured context (2026-06-22, ASYNC lane)

The async cluster is **76.6% passing (2449/3199)** on current main via the
**legacy synchronous-async path** (`AwaitExpression` no-op at
`expressions.ts:1165`; call-site `wrapAsyncReturn` at `expressions.ts:280`).
The CPS state-machine (`async-cps.ts`) is fully built but gated **OFF**
(`ASYNC_CPS_ENABLED = false`) because flipping it globally regresses the
synchronous-consumption contract (see #1042). So the residual is a set of
**discrete bounded bugs in the legacy path**, not the epic. This issue is the
single largest such bucket in the core `async-function` directories.

## Problem

The async-call-site Promise wrap (`wrapAsyncReturn`) only fires when the call
is recognised as async by `isAsyncCallExpression` (`src/codegen/expressions.ts:156`).
For an async function **expression** bound to a variable —

```js
var ref;
ref = async function ref(x, y = x) { /* ... */ };
ref(3).then(() => { /* ... */ }).then($DONE, $DONE);   // asyncHelpers.js / generated tests
```

— the call `ref(3)` is **not** detected as async:

- `ctx.asyncFunctions.add(name)` (`declarations.ts:2561`, `:3002`,
  `class-bodies.ts:912`, `literals.ts:2388`) only registers async function
  **declarations**, class methods, and object-literal methods — never a
  function-expression assigned to a `var`/`let`. So the
  `ctx.asyncFunctions.has(expr.expression.text)` check at
  `expressions.ts:188-190` misses `ref`.
- The signature-resolution fallback (`expressions.ts:192-202`) reads
  `sig.getDeclaration()`'s modifiers. For a call through a `var ref` whose
  declared type is just `(x: number) => Promise<number>` (TS infers the
  function type, losing the `async` modifier on the synthesized declaration),
  the resolved declaration is the function expression — but the modifier walk
  can miss it when the binding indirection drops the original node.
- The `calleeType.getCallSignatures()` / `isPromiseType(returnType)` fallback
  (`expressions.ts:217-220`) should catch it, but only if TS surfaces
  `Promise<T>` as the call signature's return type through the variable. For
  the `var ref; ref = async function …` two-step pattern (declare-then-assign,
  no initializer type) TS widens `ref` to the contextual type and the async
  return is **not** reliably visible.

Result: `ref(3)` returns the raw unwrapped value; `.then` on it →
`Cannot read properties of null (reading 'then')` (the test harness
`asyncTest`/generated `.then($DONE, $DONE)` chain dereferences null).

## Failing tests (re-measured from baseline JSONL, 2026-06-22)

`test/language/expressions/async-function/` — `runtime_error:Cannot read
properties of null (reading 'then')`:

- `named-params-trailing-comma-single.js`, `named-params-trailing-comma-multiple.js`
- `nameless-params-trailing-comma-single.js`, `nameless-params-trailing-comma-multiple.js`
- `named-dflt-params-ref-prior.js`, `nameless-dflt-params-ref-prior.js`
- `named-dflt-params-arg-val-undefined.js`, `nameless-dflt-params-arg-val-undefined.js`
- `named-dflt-params-arg-val-not-undefined.js`, `nameless-dflt-params-arg-val-not-undefined.js`
- `named-dflt-params-trailing-comma.js`, `nameless-dflt-params-trailing-comma.js`
- `forbidden-ext/b2/async-func-expr-{named,nameless}-forbidden-ext-indirect-access-{prop-caller,own-prop-caller-value,own-prop-caller-get}.js` (6 files)

≈ **18 tests**. (The `async-func-**decl**` statement-form siblings already
pass — they go through `ctx.asyncFunctions`.)

## Implementation Plan

### Root cause
`isAsyncCallExpression` cannot see the `async` brand of a callee reached
through a variable/expression binding when TS doesn't surface `Promise<T>` on
the variable's call signature. The fix is to broaden detection so the
`.then`/thenable consumer path wraps the result.

### Changes

**File: `src/codegen/expressions.ts`**

- Function `isAsyncCallExpression` (line 156). The `calleeType.getCallSignatures()`
  loop at 217-220 is the right hook but is incomplete. Strengthen it:
  1. When `expr.expression` is an identifier, resolve its **symbol** via
     `ctx.checker.getSymbolAtLocation(expr.expression)` and walk
     `symbol.declarations`. If any declaration is a `VariableDeclaration` /
     `BindingElement` / assignment whose initializer (or the RHS of a later
     `=` assignment) is an `async` function expression / async arrow, return
     `true`. Use `ts.isFunctionLike(init) && hasAsyncModifier(init)` (reuse
     `hasAsyncModifier` from `declarations.ts`). This catches the
     `var ref; ref = async function …` two-step exactly.
  2. Also consult `ctx.checker.getApparentType(calleeType)` call signatures,
     not just `calleeType.getCallSignatures()` — the apparent type unwraps the
     variable to its function type more reliably.
- Keep the existing `Promise.then`/`.catch` standalone short-circuits
  (lines 162-186) untouched — they must still return `false` to avoid
  double-wrapping native `$Promise` receivers.

### Wasm IR pattern
No new IR. Once detection returns `true`, the existing `wrapAsyncReturn`
(`expressions.ts:280`) emits `Promise_resolve(value)` → externref, and
`wrapAsyncCallInTryCatch` wraps synchronous throws (default-param TDZ /
trailing-comma evaluation) into rejected Promises (matches the
`forbidden-ext` / `dflt-params` test intent).

### Edge cases
- `await ref(3)` consumer — `asyncResultConsumedAsValue` must still return
  `true` (raw-value passthrough) for the await case; do NOT regress it. Only
  the `.then`/thenable consumer path should newly wrap. The
  `classifyAsyncConsumer` three-state classifier (`async-cps.ts:336`) already
  separates `await`/`value`/`thenable` — detection broadening here only
  changes whether the call is *async at all*, not which consumer bucket it
  lands in.
- `ref` reassigned to a non-async function later — accept the broadened
  detection (worst case an extra harmless `Promise.resolve` wrap on a
  sync value, which the JS host assimilates). Guard against double-wrap only
  for the already-Promise-returning cases (the existing `Promise.`-receiver
  short-circuit handles those).
- Object-literal / class async methods called through a variable — out of
  scope here (separate detection path); file forward if any test surfaces.

### Test files to verify (must flip pass)
- `test/language/expressions/async-function/named-dflt-params-ref-prior.js`
- `test/language/expressions/async-function/nameless-params-trailing-comma-single.js`
- `test/language/expressions/async-function/forbidden-ext/b2/async-func-expr-named-forbidden-ext-indirect-access-prop-caller.js`

### Regression watch
- `test/language/statements/async-function/*` (must stay green — they use the
  decl path and `ctx.asyncFunctions`).
- `tests/equivalence/async-function.test.ts` + `tests/equivalence/promise-chains.test.ts`
  — the raw-value-consumption tests (`asyncFn() as any as number`) must stay
  green; the broadened detection must not make those wrap (they go through the
  `value` consumer / `asyncResultConsumedAsValue === true` path).

### Estimate
~30 LoC in `isAsyncCallExpression` + ~40 LoC tests. **~18 test262 pass.**
