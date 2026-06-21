---
id: 2574
title: "array destructuring default not applied when the element value is `undefined` (standalone)"
status: ready
sprint: Backlog
created: 2026-06-21
updated: 2026-06-21
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: destructuring, defaults
goal: standalone-mode
related: [2040, 2545, 2568]
origin: "2026-06-21 sd-3 — found while root-causing #2040 cluster A. Orthogonal to the #2040 _isSameValue codegen bug."
---

# #2574 — array-destructuring default not applied on an `undefined` element

## Problem

Per ES §8.5.3 (IteratorBindingInitialization, `SingleNameBinding` with an
Initializer), the default is applied when the bound value is `undefined` — NOT
only when the iterator is `done`. In standalone mode the default is skipped when
the element value is explicitly `undefined`:

```ts
const [a = 9] = [undefined];   // standalone: a === NaN   expected: a === 9
```

Compare (both already correct on main):

```ts
const [a = 9] = [5];   // a === 5   ✓
const [a = 9] = [];    // a === 9   ✓ (done → default)
```

So the missing arm is specifically: element present in the iterator but its
value is `undefined` ⇒ apply the default.

## Repro (current main, `--target standalone`)

```ts
export function test(): number { const [a = 9] = [undefined as any]; return a; }
// actual: NaN   expected: 9
```

## Suggested approach

In the array-destructuring element lowering (`src/codegen/destructuring-params.ts`
and/or the decl path in `statements/destructuring.ts`), the default-application
guard must fire on `value === undefined`, not only on iterator-`done`. The
`done`-only path already works; widen the predicate to
`done || value === undefined` (the §8.5.3 "If v is undefined" step), then apply
the Initializer. Scope to array binding patterns with a default; object-pattern
defaults (§8.5.4) already cover the `undefined` case — verify both.

## Acceptance criteria

- `const [a = 9] = [undefined]` → `a === 9` standalone; host unchanged.
- `const [a = 9] = [5]` / `const [a = 9] = []` stay correct (no regression).
- Object-pattern default-on-undefined verified.
