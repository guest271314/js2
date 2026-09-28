---
id: 6731
title: "Native generator residuals after the #680 prettier slice: for-of body throw does not IteratorClose, break/continue/return/yield* in a yielding for-of, `??` statements, rest in destructuring declarations, string-carrier spread"
status: ready
sprint: current
created: 2026-09-28
updated: 2026-09-28
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone-mode
---

## Context

The #680 prettier slice (2026-09-28) taught the standalone native generator
planner four shapes: `&&` / `||` / `?:` / comma expression statements with a
yield in a deferred operand, `for (x of <non-iterator subject>)` over the
native `__iterator` protocol, non-numeric branch conditions (canonical
ToBoolean), and destructuring-declaration locals as frame spills. These are
the edges it deliberately left, each measured or read from the code.

## Residuals

1. **A runtime throw from a yielding for-of BODY does not IteratorClose the
   loop's iterator** (§14.7.5.7 step 6). The linearised loop closes it on an
   abrupt RESUME (`.return()` / `.throw()` at a yield — `dstr-close` unwind
   entry) and on a throwing loop op, but plain body statements are not wrapped.
   Shared with A2's `lowerForOf` and the #6651 A4 pattern-head loop.
2. **`break` / `continue` / `return` / `yield*` inside a yielding for-of body
   still refuse the generator** (same gates as the pattern-head loop).
3. **`A ?? (yield B);`** is not desugared (its test is nullishness, not
   ToBoolean), nor is a yield in the CONDITION operand of `&&` / `||` / `?:`.
4. **Rest elements of a destructuring declaration** (`let {a, ...r} = o`) are
   still not spilled (the destructure re-allocates the rest slot, #971), so a
   read after a suspension sees the frame default. Non-rest names are fixed.
   The JS-host lane keeps the pre-slice behaviour for all of these (not
   measured there).
5. **Spreading a native string-carrier generator into `any[]`** yields an empty
   array: `[...(function*(){ yield "x"; yield "y"; })()]` has length 0 in
   standalone (for-of over the same generator sees both values). Pre-existing
   on main `2e23e49fb1`.
6. Scoped standalone test262 rows still refused with the #680 diagnostic
   (2026-09-28, generators + GeneratorPrototype + yield + for-of-with-generators
   scope): `built-ins/GeneratorPrototype/return/try-finally-set-property-within-try.js`,
   `language/expressions/yield/from-with.js`, `language/expressions/yield/rhs-regexp.js`,
   `language/statements/generators/scope-param-rest-elem-var-{open,close}.js`.

## Acceptance

Each item fixed or split with a regression test that fails on its parent;
scoped standalone test262 over the same four directories with no losses.
