---
id: 3532
title: "codegen: bare empty array literal `[]` in a conditional under a union contextual type mistypes the closure (invalid Wasm)"
status: ready
sprint: current
created: 2026-07-22
priority: low
horizon: m
feasibility: medium
task_type: bugfix
area: codegen
language_feature: codegen-correctness
goal: correctness
related: [2717]
---

# #3532 — conditional bare-`[]` under a union contextual type mistypes the closure

**Source:** surfaced while adding the native standalone `Array.prototype.flatMap`
arm (#2717).

## Problem

When a callback is contextually typed as a union of an array and something else
(e.g. `Array.prototype.flatMap`'s `(v) => U | readonly U[]`), a **bare empty
array literal `[]`** in a conditional branch resolves to a DIFFERENT WasmGC vec
type than a sibling non-empty array in the other branch. The closure's two
branches then don't unify, producing an invalid closure — a Wasm
`type error in fallthru (expected (ref null N), got (ref null M))` at instantiate.

Minimal repro (default gc lane compiles fine because map's contextual type is
`U`, not a union; the bug needs a union contextual type — flatMap in standalone
is the observed trigger):

```ts
// --target standalone
const a: number[] = [1, 2, 3];
a.flatMap((x) => (x % 2 === 0 ? [] : [x])); // INVALID closure
```

Discriminators (all verified):

| callback branches            | result  |
| ---------------------------- | ------- |
| `? [] : [x]` (empty first)   | INVALID |
| `? [x] : []` (empty second)  | INVALID |
| `? [] : arr` (empty + var)   | INVALID |
| `? [x,x] : [x]` (both lits)  | valid   |
| `? [x] : arr` (lit + var)    | valid   |
| `? p : q` (two vars)         | valid   |
| `=> []` (always empty)       | valid   |

So the trigger is precisely: an empty array literal `[]` **mixed with a
non-empty array** in a conditional, under a union contextual type. The static
return type does NOT discriminate (both report `number[]`).

## Current mitigation (#2717)

The native flatMap arm refuses these a-priori: `inlineCallbackHasEmptyArrayLiteral`
(`src/codegen/array-methods.ts`) rejects any inline arrow/function-expression
callback whose body contains a bare `[]`, falling back to the loud refusal. This
is over-conservative (also refuses a benign always-`[]` callback) but never emits
invalid Wasm. No real test262 flatMap callback uses a bare-`[]` shape, so the flip
count is unaffected.

## Fix direction

Make the empty array literal `[]` in a conditional coerce to the sibling
branch's / the contextual-target's concrete vec type (the same way `map`'s
non-union contextual type already forces `[]` → `number[]`). This is a
conditional-expression / array-literal-typing change in the closure/element-type
resolution — broad-impact, needs full test262 CI. Once fixed, remove the
`inlineCallbackHasEmptyArrayLiteral` a-priori guard in the flatMap arm.

## Acceptance criteria

- `[1,2,3].flatMap(x => cond ? [] : [x])` compiles + runs correctly in
  `--target standalone` (and any other union-contextual `[]`-in-conditional
  shape), producing the flattened result.
- The `inlineCallbackHasEmptyArrayLiteral` guard can be removed with no new
  invalid-Wasm.
- No regression in the default gc lane.
