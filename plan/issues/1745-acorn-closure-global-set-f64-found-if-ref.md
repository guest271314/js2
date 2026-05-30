---
id: 1745
title: "acorn dogfood: __closure_37 global.set expects f64, found if of (ref null 3) → invalid Wasm"
status: ready
created: 2026-05-30
updated: 2026-05-30
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, closures, type-coercion
language_feature: closures, global-set, conditional-result-coercion
goal: self-hosting-dogfood
sprint: Backlog
parent: 1711
related: [1734, 1725, 1710]
---
# #1745 — acorn closure `global.set` expects f64, finds an `if` of `(ref null 3)` → invalid Wasm

## Problem

The **next** acorn dogfood blocker after #1734 (which cleared the
`__closure_11` unguarded-`struct.get` failure). `compile(acorn.mjs)` still
returns `success=true`, but the emitted binary fails `WebAssembly.compile()`:

```
WebAssembly.compile(): Compiling function #130:"__closure_37" failed:
  global.set[0] expected type f64, found if of type (ref null 3)
  @+210580
```

The whole acorn surface stays gated on this (`binaryValidates:false`, the 5
runtime-AST-diff fixtures stay skipped).

## Root cause (hypothesis — to confirm)

`__closure_37` stores into a module global whose declared type is **f64**, but
the value it computes is the result of an **`if` block** whose result type is
`(ref null 3)` — i.e. a reference, not an f64. So a value that is conditionally
a ref (likely a captured variable's ref-cell / closure struct, type index 3)
is being written into an f64-typed global without coercion.

This is a **conditional-result → global type** coercion gap, distinct from
#1734's struct.get-receiver gap:
  - either the global's declared type (f64) is wrong for what's stored (it
    should be externref / a ref), or
  - the `if`-block result (a ref) must be coerced to f64 (boxed → unboxed, or
    via `__box_number` round-trip) before the `global.set`, and that coercion
    is missing on one arm / the whole block.

Type index 3 is a low/early struct type (likely a ref-cell `struct (field
$value (mut T))` or an early closure/$AnyString-ish type) — confirm which.

## How to reproduce

```bash
# worktree branched off origin/main, WITH the #1734 fix applied/merged
pnpm run dogfood:acorn
# → compile() success=true; WebAssembly.compile() FAILS on
#   __closure_37 global.set[0] expected f64, found if of (ref null 3).
```

A minimal in-repo reducer is part of this issue's work: a closure that writes a
**conditionally-ref value** (e.g. `g = cond ? someRefThing : otherRefThing`)
into a variable/global the compiler typed as f64 — reduce until the
`global.set[0] expected f64, found if` validator error reproduces. Pin as
`tests/issue-1745.test.ts` (compile + `WebAssembly.compile` succeed).

## Acceptance criteria

1. `WebAssembly.compile()` of compiled `acorn.mjs` no longer fails on
   `__closure_37` (the harness advances to the next blocker, if any).
2. The `global.set` operand is well-typed: either the global is declared with
   the right reference type, or the `if`-block result is coerced to f64 before
   the store.
3. A minimal `tests/issue-1745.test.ts` reducer compiles AND validates.
4. No regression in closures / global / coercion buckets or
   `tests/equivalence/`.

## Notes / scope

- Validator offset `@+210580` and function index `#130` are pin-specific
  (acorn 8.16.0); the *symbol* `__closure_37` + the
  `global.set[0] expected f64, found if of (ref null 3)` shape are the stable
  anchors.
- Surfaced by the #1710 dogfood harness immediately after the #1734 fix; this
  is the next acceptance-class (codegen-acceptance / won't-validate) gate on
  the path to #1712.
