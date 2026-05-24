---
id: 1617
title: "codegen: loop pre-box wrongly boxes body-local let/const captured by closure → ref.is_null over f64 (invalid wasm)"
status: done
created: 2026-05-24
updated: 2026-05-24
completed: 2026-05-24
priority: high
feasibility: hard
task_type: bugfix
area: codegen
language_feature: closures-per-iteration-binding
goal: compiler-correctness
sprint: 56
es_edition: es2015
related: [1602, 1603, 1589, 1453]
---
# #1617 — Loop pre-box boxes body-local let/const captured by a closure → `ref.is_null` over f64

## Problem

The deployed playground calendar example fails to instantiate:

```
Compiling function #25:"renderCal" failed:
  ref.is_null[0] expected reference type, found local.get of type f64 @+8105
```

User-facing flagship DOM example (`playground/examples/dom/calendar.ts`).
Sibling of the #1602 / #1603 f64↔ref coercion family — same "invalid wasm
because a ref op is applied to an f64 value" shape, but a distinct root cause
in the **closure per-iteration binding** machinery.

## Repro (minimal)

```ts
function renderCal(): void {
  for (let d = 1; d <= 31; d++) {
    const day = d;                  // body-local block-scoped const, type number → f64
    const f = () => { return day; }; // captured by a closure
  }
}
```

Compiling `renderCal` yields invalid wasm. No null-check, no `gridEl`, no DOM
needed — the trigger is a **body-local `let`/`const` number variable captured
by a closure inside a `for` loop**. The misleading `if (gridEl === null)` in
the original source is NOT involved.

## Root cause

The #1589 pre-box pass in `src/codegen/statements/loops.ts`
(`findAllNamesCapturedByClosuresInForLoop` → `preBoxedNames` loop) exists to
promote **`var`-declared / enclosing-function** variables captured by a closure
to a ref-cell *before* the loop condition is compiled (otherwise the condition
reads the unboxed slot and the loop spins forever).

But `findAllNamesCapturedByClosuresInForLoop` returns **every** identifier
referenced inside any closure in the loop — including body-local `let`/`const`
names like `day`. The pre-box pass had no guard to exclude them, so for `day`:

1. `hoistLetConstWithTdz` had already pre-allocated an **f64** value slot for
   the body's `const day`.
2. The pre-box pass read `oldLocalIdx = localMap.get("day")` (the hoisted f64
   slot), boxed it at loop head into a `__pre_box_day` ref-cell, and redirected
   `localMap["day"]` → the cell, plus registered `boxedCaptures["day"]`.
3. When the body declaration `const day = d` compiled
   (`src/codegen/statements/variables.ts`), the boxed-init branch
   (`boxedForInit`, lines ~565-588) fired. It emits `local.get localIdx;
   ref.is_null; (if … struct.set …)` — but `localIdx` resolved to the **f64**
   hoisted slot (the `(local $day f64)`), not the ref-cell. Result:
   `ref.is_null` over an f64 → invalid wasm.

The deeper invariant violated: a body-local `let`/`const` is **block-scoped to
each iteration**. It is handled correctly by the body declaration + the
closure-construction path (which boxes it per-iteration with the right local
index). It must NOT be pre-boxed at the loop head, where the binding does not
even exist yet.

## Fix

`src/codegen/statements/loops.ts`:

- Added `findBodyLocalLexicalNames(stmt)` — collects names lexically declared
  (`let`/`const`/`using`, class, function) at the top level of the loop body.
- In the #1589 pre-box pass, skip any captured name that is in that set.

This is a ~30-line, surgical narrowing of the pre-box candidate set. It does
not touch the `var`/enclosing-variable infinite-loop fix (#1589) nor the
per-iteration head-binding cells (#1453) — those names are not body-local
lexical declarations, so they are unaffected.

## Verification

- `playground/examples/dom/calendar.ts` → `new WebAssembly.Module()` validates.
- Minimal repro + variants (closure capturing body-local number, two closures,
  loop with DOM appendChild) all validate.
- #1589 `var`-capture loop still compiles (no regression in the pre-box path).
- Regression test: `tests/issue-1617.test.ts` (per-iteration capture semantics
  + module validity).

## Files

- `src/codegen/statements/loops.ts` — `findBodyLocalLexicalNames` + pre-box guard
- `tests/issue-1617.test.ts` — regression test
