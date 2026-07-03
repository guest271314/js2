---
id: 2676
title: "≤ES3: mapped arguments — strict-mode aliased `delete args[i]` must throw TypeError on a non-configurable index (residual of #2667)"
status: done
assignee: ttraenkler/es3-2676
created: 2026-06-25
updated: 2026-07-03
completed: 2026-06-30
priority: high
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 0
language_feature: arguments-object
goal: spec-completeness
depends_on: []
related: [2667, 1511]
sprint: 69
---
# #2676 — ≤ES3 mapped-arguments strict aliased delete throws (residual of #2667)

## Edition / impact

- **Edition:** ≤ES3 (sloppy mapped `arguments`, but the delete site is strict).
- **Fail count:** **4** `language/arguments-object/mapped/*` tests.
- Residual carved out of #2667 (which fixed the 8 non-strict cases). Part of the
  ≤ES3 full-coverage goal.

## Problem

```
language/arguments-object/mapped/mapped-arguments-nonconfigurable-strict-delete-1.js .. -4.js
```

Representative:
```js
function argumentsAndStrictDelete(a) {
  Object.defineProperty(arguments, "0", { configurable: false });
  var args = arguments;                                  // (1) alias
  assert.throws(TypeError, function() {                  // (3) nested fn
    "use strict";                                        // (2) strict context
    delete args[0];                                      //     must THROW
  });
  assert.sameValue(a, 1);
  assert.sameValue(arguments[0], 1);
}
argumentsAndStrictDelete(1);
```

In **strict** mode, `delete` of a non-configurable own property throws a
TypeError (§13.5.1.2 / OrdinaryDelete with `Throw = true`). Currently the
compiled `delete args[0]` returns normally (the test then fails the
`assert.throws`).

Three things make this harder than the #2667 static path:

1. **Aliasing** — the receiver is `args` (a `var` initialized to `arguments`),
   not the literal `arguments` identifier #2667's tracking keys on.
2. **Strict context** — the delete is inside a nested non-arrow function with
   its own strict prologue, so `args` is a closure capture and the strict bit
   lives on the inner function, not the outer mapped one.
3. **Conditional throw** — must emit a runtime TypeError only when the target
   index is non-configurable.

## Acceptance criteria

- All 4 `mapped-arguments-nonconfigurable-strict-delete-*` tests pass.
- No regression in the #2667 non-strict mapped cases or the rest of
  `language/arguments-object/mapped`.

## Notes

- The #2667 fix tracks per-index `nonConfigurableIndices` in `mappedArgsInfo` at
  compile time. A solution here likely needs either (a) alias-resolution from
  `args` back to the captured `arguments` vec + the outer function's
  `mappedArgsInfo`, or (b) a runtime descriptor on the arguments object so a
  strict `delete` consults real configurability and throws. Option (b) overlaps
  with the broader arguments-object descriptor-fidelity gap (#2668).

## Resolution (option (a), compile-time alias resolution)

Chose option (a) — no substrate/runtime-descriptor change (option (b) is
deferred with #2668). The compile-time `nonConfigurableIndices` set from #2667
is already authoritative for the statically-resolvable
`Object.defineProperty(arguments, "<i>", { configurable:false })` shape these
tests use; the only missing piece was making it reachable from the aliased
delete site in the nested strict closure.

- **Expose the info across the closure boundary.** Added
  `ctx.mappedArgsInfoByFunc: Map<ts.Node, mappedArgsInfo>`, populated wherever a
  mapped (sloppy, simple-param) function's `mappedArgsInfo` is created — the
  top-level path (`compileFunctionBody`) and both nested-lift paths
  (`nested-declarations.ts`). The stored value is the **live** info object, so
  the `nonConfigurableIndices` set it carries reflects every `defineProperty`
  processed before the delete is compiled. (Ordering holds: the
  `defineProperty` textually precedes the `assert.throws(...)` closure, and the
  map entry itself is created at function-entry, before either.)
- **Resolve the alias at the delete site** (`typeof-delete.ts`,
  `resolveAliasedMappedArgs`): for `delete <id>[<literal>]`, walk `<id>`'s symbol
  → its `var <id> = arguments` value declaration → the nearest enclosing
  non-arrow function (the `arguments` owner) → `ctx.mappedArgsInfoByFunc`. A hit
  whose `nonConfigurableIndices` contains the literal index means OrdinaryDelete
  fails: emit `i32.const 0` (`false`) and route it through the **existing**
  `emitStrictDeleteCheck`, which throws TypeError in a strict context
  (§13.5.1.2 step 6.b) and leaves `false` in a sloppy one — identical to the
  #2667 direct-`arguments[i]` arm.
- **Why this is downstream-safe.** No emitted-code change to any existing path:
  the new map is pure bookkeeping, and the delete arm is gated on a *non-empty*
  `nonConfigurableIndices` + an in-range literal index on a resolved
  `arguments` alias. Configurable indices, unmapped/strict `arguments` (which
  never get `mappedArgsInfo`), transitive aliases, and all non-arguments
  deletes fall straight through to the prior behaviour. Stack balance is
  unchanged — the arm produces exactly one i32 like every other delete arm.

**Verification** — fresh single-file runs (mirroring `test262-worker`): all 4
`mapped-arguments-nonconfigurable-strict-delete-{1..4}` flip fail→pass. The
`language/arguments-object/mapped` directory goes 35→39 pass (the 4 targets),
0 regressions; the remaining 4 fails there are pre-existing descriptor-fidelity
cases (#2668), unchanged. `tests/issue-2676.test.ts` adds the core case plus
sloppy-returns-false, configurable-index-does-not-throw, and regular-object
strict-delete controls.
