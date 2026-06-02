---
id: 1745
title: "acorn dogfood: __closure_37 global.set expects f64, found if of (ref null 3) → invalid Wasm"
status: done
created: 2026-05-30
updated: 2026-05-31
completed: 2026-05-31
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

## Root cause (confirmed) & fix

**Not a coercion gap — a module-global name-collision / missing var-shadow in
closures.**

The hypothesis in "Root cause" above (a missing ref→f64 coercion on the
`global.set` value) was *not* the actual cause. Diagnosing the `__closure_37`
body byte-for-byte showed:

- The colliding global is the module global **`i`** (declared **f64** — it is
  hoisted from acorn's top-level `for (var i = 0, list = [...]; ...)` at
  acorn.mjs:3990, where `i` is purely a numeric loop counter).
- Inside `__closure_37`, a **function-scoped** `var i`/`var list` (in a
  *different* lexical scope — a nested function whose `i`/`list` hold an
  *array*, built via `array.new_default` + a fill loop + `struct.new`) was
  being written through `global.set $__mod_i`. The vec-struct ref
  `(ref null 3)` value into the f64-typed global is the invalid Wasm.

Why the wrong binding happened: **regular functions run
`hoistVarDeclarations` (function-body.ts) which pre-allocates a function-local
for every `var` and — per #1690b — that local SHADOWS any same-named module
global (ECMA-262 §10.2.10). Closures/arrows never ran that pass** (closures.ts
only ran `hoistLetConstWithTdz`). So a `var` inside a closure body whose name
collided with a differently-typed module global fell through `hasLocalShadow`
(`fctx.localMap.has(name)` was false) to `global.get/set $__mod_<name>`,
emitting a value whose type did not match the global's declared type.

A second, narrower instance of the same defect: the C-style for-loop *init*
path in `statements/loops.ts` reached for `ctx.moduleGlobals.get(name)`
*without first* checking for a function-local shadow — so even after a `var i`
was hoisted to a local, `for (var i = …; …)` still re-bound to the module
global.

### Fix (two edits, no coercion hacks)

1. `src/codegen/closures.ts` — call `hoistVarDeclarations` for the closure
   body in BOTH closure-compile paths (the lifted-closure path and the
   callback path), before `hoistLetConstWithTdz`, mirroring `function-body.ts`.
   `walkStmtForVars` does not cross nested function scope boundaries, so
   genuinely-captured free variables are untouched.
2. `src/codegen/statements/loops.ts` — the for-init module-global branch now
   honours a function-local shadow (`fctx.localMap.has(name)`) before binding
   to the module global, matching the `hasLocalShadow` guard in
   `statements/variables.ts`.

### Verification

- `tests/issue-1745.test.ts` — 3 cases (2 compile+`WebAssembly.compile`
  validation, 1 runtime asserting the shadowed closure var does NOT clobber the
  module global → returns 203). All pass.
- Acorn (awaited `compile()` probe): **`__closure_37` no longer fails**.
  `compile()` succeeds (≈831 KB) and `WebAssembly.compile()` advances past
  `__closure_37` to the **next** blocker (`__closure_86`:
  `f64.trunc[0] expected f64, found global.get of (ref null 1)` on the
  free-variable read of module global `empty$1`). That next blocker is a
  *distinct* root cause (a genuine free-variable read of a ref-typed module
  global used numerically — NOT a `var`-shadow), so it is out of scope for
  #1745 and should be filed as a follow-up dogfood blocker.
- Equivalence suite (`tests/equivalence/`): JSON-diffed my branch vs. clean
  base — **0 new failures, 0 fixed** (the 65 pre-existing failures are
  identical on both trees; they are unrelated harness/env issues).

### Why not the coercion approach

Coercing the array ref → f64 at the `global.set` would have produced a binary
that validates but silently corrupts the value (an array truncated to `NaN`),
and would have entrenched the name-collision bug. Shadowing the `var` is the
ECMA-correct fix: the closure's `var i` is a *different variable* from the
top-level `i`, so it gets its own local and the module global keeps its f64
type for the numeric usages.
