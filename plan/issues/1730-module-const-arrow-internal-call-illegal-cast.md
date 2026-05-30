---
id: 1730
title: "internal call to a module-level `const` arrow traps with illegal cast"
status: ready
created: 2026-05-29
updated: 2026-05-29
priority: medium
task_type: bugfix
area: codegen
language_feature: closures, arrow-functions
goal: test262-conformance
related: [1727, 1115]
---

# #1730 — internal call to a module-level `const` arrow → "illegal cast"

## Problem

Calling a module-level `const`-bound arrow function from another function
(internal wasm `call_ref` dispatch, not the export boundary) traps at runtime
with `RuntimeError: illegal cast`. This is **independent of async** — a plain
synchronous arrow reproduces it:

```ts
const f = (x: number): number => x * 2;
export function main(): number { return f(21); }
// RuntimeError: illegal cast (expected 42)
```

The async variant traps identically:

```ts
const double = async (x: number): Promise<number> => x * 2;
export function main(): number { return double(21) as any as number; }
// RuntimeError: illegal cast (expected 42)
```

## Root cause (narrowed — dev, 2026-05-29)

NOT the #1727 Promise-wrap path. With the #1727 fix in place,
`asyncResultConsumedAsValue` correctly skips the wrap and the recorded
`callResult` ValType is `f64` — the value path is correct. The trap is at the
**closure dispatch site**: the `ref.cast` of the stored closure ref to its
specific wrapper struct type fails. The module-level `const` arrow is stored /
re-resolved in a way that the call-site `ref.cast` does not match (compare the
inline arrow / passed-as-arg paths, which work). Lives in `src/codegen/closures.ts`
closure call_ref dispatch (the `ref.cast typeIdx structTypeIdx` at the call
site, see closures.ts ~1699 / dispatch ref.cast), not in the async wrap.

## Further narrowing (senior-dev, 2026-05-30)

Reproduced the trap and bisected the two call shapes:

- **`f(21)` (direct call)** → TRAPS `illegal cast`.
- **`const g = f; g(21)` (via intermediate local)** → WORKS (returns 42).

The intermediate-local path loads the callee correctly:
`local.set $0 (extern.convert_any (global.get $global$0))` — `global$0` holds
the closure struct `(struct.new $0 (ref.func $__closure))`.

The direct-call path instead emits, inside the `call_ref` argument region, a
self re-resolution that **casts the wrong global**:
`ref.cast (ref null $0) (any.convert_extern (global.get $gimport$3))` where
`gimport$3` is the imported `"TypeError: Cannot access property…"` message
string global — the direct-call self-load grabs a garbage global instead of
`global$0`, then `ref.cast` to the closure struct type traps.

So the defect is in the **direct `Identifier(args)` dispatch for a
module-`const`-bound arrow** (`src/codegen/expressions/calls.ts`): the
closure-self/receiver load resolves the callee from the wrong global rather
than `ctx.moduleGlobals.get("f")` (`global$0`). The wrapper-types branch at
~7996 (`compileExpression(expr.expression)` → `any.convert_extern` →
`emitGuardedRefCast` → saved to a local) is the *correct* shape — the failing
path is a *different* arm that loads self from a sentinel.

## Repro / acceptance

- `const f = (x:number):number => x*2; main(){ return f(21); }` → 42 (no trap).
- The async-arrow variant (the `it.skip("async arrow function (#1730 ...)")`
  case in `tests/equivalence/async-function.test.ts`) flips green; un-skip it.
- No regression in inline-arrow / callback-arrow dispatch.

## Source

Surfaced while fixing #1727 (async-call NaN). The async-arrow equivalence case
was attributed to async but is a general module-const-arrow dispatch bug;
split out so #1727 ships the actual Promise-wrap fix without expanding into
closure-ABI work.
