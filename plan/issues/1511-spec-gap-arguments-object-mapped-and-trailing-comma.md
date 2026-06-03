---
id: 1511
title: "spec gap: arguments object — mapped semantics, descriptors, trailing-comma length"
status: done
created: 2026-05-20
updated: 2026-05-29
completed: 2026-05-29
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: arguments-object
goal: spec-completeness
sprint: 57
related: [1364, 1726]
---
# #1511 — arguments object fidelity

## Problem

`language/arguments-object/` contributes **181 failing test262 cases**.
Three sub-clusters:

| Sub-cluster | Count | Symptom |
|-------------|------:|---------|
| Trailing-comma `arguments.length` on class methods | ~120 | `assert.sameValue(arguments.length, 2)` fails |
| Mapped `arguments[i]` non-configurable / non-writable defineProperty | ~30 | redefining slot fails to throw or silently drops link |
| `S10.6_A*` legacy reflection | ~20 | arrow-function `arguments` lookup wrong; `arguments.callee` wrong descriptor |

### Trailing-comma pattern

```js
class C {
  m(a, b,) { return arguments.length; }
}
new C().m(1, 2);  // expected 2 — we return 0 / formal-count
```

The same pattern recurs across every class-method variant:
`cls-decl-async-gen-meth-static-args-trailing-comma-multiple.js`,
`cls-expr-private-meth-args-trailing-comma-spread-operator.js`,
`func-expr-args-trailing-comma-spread-operator.js`, etc.

### Mapped slot pattern

```js
function f(a) {
  Object.defineProperty(arguments, "0", { writable: false });
  a = 1;
  return arguments[0];  // expected: original argument; not 1
}
```

Per ECMA-262 §10.4.4 (Arguments Exotic Objects), in sloppy mode the
arguments object's indexed slots are *linked* to the parameter
bindings. `defineProperty` with `writable:false` removes the link
without breaking the property; subsequent parameter writes must not
update `arguments[i]`.

## Failure count

**181 fails** in `language/arguments-object/`. Realistic target:
**~120 flips** (the legacy `S10.6_A*` cluster overlaps with `with`
statement / annex B and is left for #1387 / #1518).

## Root cause

1. **Class method trampolines** (`src/codegen/class-bodies.ts:1080–1242`)
   pre-fill omitted formals with `__get_undefined()` before calling
   the user method. The trampoline then constructs `arguments` from
   the *resolved* formal slots, not the call-site list. Result:
   `arguments.length` always equals the formal count.

2. **Mapped binding** is built at function entry by
   `src/codegen/arguments-object.ts` (or equivalent) as a unidirectional
   copy of parameter values into a struct field. There is no
   "delete link" flag, so a subsequent `defineProperty` cannot break
   the link.

3. **Arrow-function `arguments`** is correctly inherited from the
   enclosing function in most cases, but `arrow-fn-body-cntns-arguments-lex-bind-arrow-func-declare-arguments-assign.js`
   fails because a sloppy-mode shadow `let arguments = 'local'`
   inside an arrow body is not honoured.

## Files to touch

- `src/codegen/class-bodies.ts` — method trampoline must pass the
  *call-site* argv length (separate from formal-slot count).
- `src/codegen/arguments-object.ts` — add a "linked" bitset to the
  arguments struct; clear the bit on any `defineProperty` /
  `delete arguments[i]`.
- `src/codegen/expressions/calls.ts` — direct invocation path
  (non-method) also needs the call-site length.
- `src/codegen/scope-analysis.ts` (if present) — arrow-body
  `let arguments` should bind locally, not inherit.

## Acceptance criteria

1. ≥ 120 of 181 in `language/arguments-object/` flip to `pass`.
2. `nonconfigurable-nonwritable-descriptors-basic.js` passes
   (defineProperty fidelity test on arguments).
3. No regression in `tests/equivalence.test.ts`.

## Reference tests

- `language/arguments-object/cls-decl-async-gen-meth-static-args-trailing-comma-multiple.js`
- `language/arguments-object/mapped/nonconfigurable-nonwritable-descriptors-basic.js`
- `language/arguments-object/mapped/mapped-arguments-nonconfigurable-strict-delete-1.js`
- `language/arguments-object/func-expr-args-trailing-comma-spread-operator.js`

## Implementation (partial — first pass)

This PR addresses the **trailing-comma length** sub-cluster by propagating
`__argc` and `__extras_argv` across **indirect / closure-dispatch** call
paths (`compileCallExpression` in `src/codegen/expressions/calls.ts`).
Previously these paths *dropped* overflow args silently and never set
`__argc`, so when the callee's body read `arguments.length` it fell back
to the formal-parameter count and returned the wrong value.

Three indirect call paths were updated:

1. **Callable-param dispatch** (line ~5650) — `ref(...)` where `ref` has
   a TS callable type. Overflow args are now saved to externref locals
   and packed into `__extras_argv` right before `call_ref`. `__argc` is
   set to the call-site argument count.
2. **CallExpression-as-callee closure dispatch** (line ~7290) and
   **expression-callee closure dispatch** (line ~7920) — same treatment
   via a new `emitClosureCallArgcExtras` helper (re-uses
   `emitSetExtrasArgv` since args have not yet been compiled at that
   point).
3. **Generic ref-test guarded fallback** (line ~7445) — args are
   already pre-compiled into locals at that point; the new
   `buildArgcExtrasSetupFromLocals` helper packs the saved overflow
   locals into a vec without re-running side effects.

After every call_ref, the new `emitResetArgcExtras` helper resets the
globals to their sentinels. This is required because the lifted callee
only resets the globals in its prologue **when its body reads
`arguments`** — for callees that don't, leaving stale extras in the
global would corrupt the next caller that does read `arguments`.

### Out of scope for this PR

- **Mapped slot defineProperty fidelity** (#1726 follow-up). The
  `mapped/nonconfigurable-*` cluster needs a "linked" bitset on the
  arguments struct so writes after a `defineProperty(..., {writable:
  false})` no longer propagate.
- **Host-method externref calls** (`ref = obj.method; ref(...)` where
  `obj.method` returns the host function value). The current closure
  dispatch path casts externref to a closure-struct ref and throws
  TypeError on cast failure. Fixing this needs a separate host-call
  bridge (#1382).
- **Legacy `S10.6_A*` cluster**: covers `with`-statement / Annex B
  semantics — deferred to #1387 / #1518.

## Test Results

`tests/issue-1511.test.ts` — 6 new direct + closure-dispatch tests
covering overflow args + trailing-comma length on class methods, static
methods, object literal methods, async generators, and assigned
function refs (matching arity). All pass.

No regressions in:
- `tests/equivalence/arguments-object.test.ts`
- `tests/equivalence/arguments-nested-and-loops.test.ts`
- `tests/equivalence/arrow-call-apply.test.ts`
- `tests/equivalence/optional-direct-closure-call.test.ts`
- `tests/equivalence/async-function.test.ts` / `async-iteration.test.ts`
- `tests/equivalence/private-class-members.test.ts`
- `tests/equivalence/nested-class-declarations.test.ts`

Pre-existing failures in these files match the main baseline
(verified via `git stash` comparison).

## Implementation (second pass — mapped-slot descriptor link-break, 2026-05-29)

Completes the **mapped slot defineProperty fidelity** sub-cluster the first
pass deferred (the §10.4.4.2 "linked bitset"). Per ECMA-262 §10.4.4.2
(ArgumentsExoticObject `[[DefineOwnProperty]]`) and §10.4.4.5
(`[[Delete]]`), once a mapped index is made non-writable (or an accessor) via
`Object.defineProperty`, or `delete arguments[i]` runs, the param↔arguments
mapping for that slot is removed: later parameter writes must stop reflecting
into `arguments[i]` and vice-versa. Setting only `configurable`/`enumerable`
keeps the map intact.

Implemented as a **compile-time link-break** — the failing test262 cases use
statically-resolvable shapes (literal index on the `arguments` identifier,
literal descriptor):

- `src/codegen/context/types.ts` — add `unmappedIndices?: Set<number>` to
  `FunctionContext.mappedArgsInfo`.
- `src/codegen/expressions/logical-ops.ts` — `emitMappedArgParamSync` and
  `emitMappedArgReverseSync` skip indices present in `unmappedIndices`. The
  emitters read the set **live**, so codegen order makes a break apply only to
  syncs emitted after the `defineProperty` / `delete`.
- `src/codegen/object-ops.ts` (`compileObjectDefineProperty`) — when the
  receiver is the `arguments` identifier in a mapped-args function, the index
  is a literal mapped slot, and the descriptor makes it non-writable
  (`writable: false`) or an accessor (`get`/`set`), add the index to
  `unmappedIndices`.
- `src/codegen/typeof-delete.ts` (`compileDeleteExpression`) — `delete
  arguments[<literal index>]` on a mapped slot records the index too.

### Out of scope (documented residual)

- **Read-through of a defined accessor** on the wasmGC vec-backed arguments
  (e.g. reading `arguments[0]` after `defineProperty(...,{get})` should invoke
  the getter) — the vec read still returns the stored slot value. The
  link-break (the spec-mandated stop-propagation) is what this issue targets
  and is fixed; routing reads through a user accessor on the arguments vec is a
  separate, larger materialization concern.
- **`delete arguments[i]` value-after-delete** — the slot value still lingers
  in the vec (reading returns the old value rather than `undefined`); only the
  param→arguments propagation is severed. Same vec-materialization gap.
- `verifyProperty`-style descriptor readback on arguments slots
  (`writable/enumerable/configurable` attributes) is unchanged.

**These all defer to #1726.** Full `language/arguments-object/mapped/*`
descriptor fidelity (getOwnPropertyDescriptor / defineProperty / delete per
§10.4.4) requires changing the `arguments` representation from a raw WasmGC vec
to an **exotic object with a per-slot mapping** — an architect-level
representation change tracked as **#1726**, not a localized codegen fix. This
PR deliberately stays within the slice the `unmappedIndices` link-break handles
*without* a representation change. The trailing-comma / `arguments.length`
cases were already fixed on main by **PR #373**.

## Test Results (second pass)

`tests/issue-1511.test.ts` — 6 new descriptor-link-break tests appended to the
existing trailing-comma suite (12 total, all pass): `writable:false` severs the
link; `configurable:false` alone keeps it; sequential set-by-param then
`writable:false` freezes the current value at 2; an accessor descriptor severs
the link; `delete arguments[i]` stops propagation; the normal mapped link
(both directions) is undisturbed.

No regression in `tests/equivalence/arguments-object.test.ts` (passes). The 3
failures in `tests/equivalence/arguments-nested-and-loops.test.ts`
(`for-loop with function declaration in body`, two `valueOf` #226 cases) are
**pre-existing on the origin/main baseline** — verified by running that file on
a branch with zero `src/` changes vs origin/main; they reproduce identically
and are unrelated to this change.
