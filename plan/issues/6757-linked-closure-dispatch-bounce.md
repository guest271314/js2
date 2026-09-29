---
id: 6757
title: "Linked lane: a closure from another module bounces between its bridge and the calling module's dispatcher until the stack overflows"
status: done
completed: 2026-09-29
created: 2026-09-29
updated: 2026-09-29
priority: high
horizon: s
goal: core-semantics
sprint: current
# (#6757) The fix lives in the new leaf src/runtime/linked-closure-dispatch.ts.
# runtime.ts grows only by the wiring: the import and the instance (2), the
# `linkedPeer` bridge parameter and its two cache guards (3), the retry in the
# dynamic bridge (13), and the host-call adapter hook (1, inside resolveImport).
loc-budget-allow:
  - src/runtime.ts
func-budget-allow:
  - src/runtime.ts::resolveImport
---

# Linked lane: foreign closure dispatch bounces until the stack overflows

## Symptom

`test/built-ins/RegExp/named-groups/duplicate-names-matchall.js` fails on the
authoritative host lane (`TEST262_ORACLE_MODE=linked`) with
`RangeError: Maximum call stack size exceeded`. It parked five merge groups in
one night (#6283, #6289, #6282 twice, #6290). The gate called it a cross-PR
flake each time, because the row's binary is identical on every one of those
PRs and on main.

It is not a flake. Through the CI worker path (`tests/test262-chunk-dynamic.test.ts`,
linked, Node 24) the row fails **every** time, alone or inside its shard (host
13/20). The "poison retry" re-ran it in a fresh fork and it failed again. Main's
promoted baseline row reads `pass` only because promote-baseline heals
poison-class rows (`poison_healed: true`).

## Root cause

The test hands the harness closures minted in the test body:

```js
assert.compareIterator(iterator, expected.map(e => v => assert.compareArray(v, e)));
```

`compareIterator` lives in the harness provider and calls `validators[i](value)`.
That is a method call on a host array, so the host invokes the closure through
the dynamic bridge (`_wrapWasmClosureUnknownArity`). The bridge was built with
the PROVIDER's exports, so it dispatched through the provider's
`__call_fn_method_1`.

That dispatcher matches closures by their exact function type, and only knows
its own module's closures. It matched no arm, and its #4618 terminal handed the
callee to the host as `__call_function_1(fn, …)` — the arm meant for a genuine
host function coming back. The host wrapped the closure with the provider's
state again, got the same cached bridge, and dispatched through the same
provider dispatcher. Stack from the worker (`--stack-trace-limit`, 3,400 frames):

```
wasmClosureDynamicBridge → wasmClosureDynamicDispatch → _applyWithPrefix
  → __ js2_call_fn_method_argc_1 → __call_fn_method_1   (provider)
  → fn2 (host __call_function_1) → invoke → applyWithVecMirrorWriteback
  → wasmClosureDynamicBridge → …
```

The #5225 owner registry cannot help: it asks `__struct_field_names`, and
closures answer "" in every module. `__closure_arity` cannot help either: it
reads the shared wrapper root, so the provider answers correctly for the
body's closure too.

## Fix

`src/runtime/linked-closure-dispatch.ts`, a bounce detector plus a retry,
active only while a linked project is live:

- Each dynamic bridge dispatch records (closure, module) on a small stack.
- The host `__call_function_N` import asks it first (`claimDispatchBounce`).
  If the call comes from the module that is dispatching that very closure, it
  can only be that module's dispatcher giving the closure back: a module's own
  closures are matched natively, and a body that is really running belongs to
  the module that minted it. The import returns without invoking anything.
- The bridge then retries through the other modules of the project (new
  `peersOf` on the #5225 registry), each through an uncached per-module bridge,
  and remembers the module that ran the closure.
- If no module can run it, the bridge throws a TypeError instead of
  overflowing the stack.

With no linked project live, `peersOf` answers `[]` and the bridge takes
exactly the old path, so the honest lane and every single-module embedder are
unchanged.

## Validation

- **The row**: CI worker path, linked, Node v24.21.0: fail → **pass**.
- **Pin** `tests/issue-6757-linked-closure-dispatch-bounce.test.ts`:
  - an in-process linked run of the same shape (body-minted validators through
    the provider's `compareIterator`): `Maximum call stack size exceeded`
    before, pass after;
  - unit tests of the detector: only the top frame, only the same module,
    retry order, owner memo, the all-miss TypeError.
- **Shard**: host 13/20 (2,437 rows), linked, Node 24, pool 4, before and after
  the fix; see the PR for the row-level comparison.
