---
id: 684
title: "Any-typed variable inference from usage patterns"
horizon: l
status: done
completed: 2026-07-17
assignee: dev-684
created: 2026-03-20
updated: 2026-07-19
priority: high
feasibility: hard
reasoning_effort: max
goal: builtin-methods
sprint: 72
# (#684) Intended god-file growth: a new context field + option and the
# wiring at the three local-slot minting sites. The analysis itself lives in
# the new module src/checker/usage-inference.ts (not a god file).
loc-budget-allow:
  - src/codegen/context/types.ts
  - src/codegen/index.ts
  - src/codegen/statements/variables.ts
  - src/compiler.ts
files:
  src/codegen/expressions.ts:
    breaking:
      - "infer concrete types for any-typed variables from usage patterns"
---
# #684 — Any-typed variable inference from usage patterns

## Status: open

When TypeScript infers `any` (common in test262 untyped JS), everything becomes externref. We lose all type info and fall back to slow host dispatch.

### Approach: usage-based type inference
Before compilation, scan how each `any`-typed variable is used:
- `x + 1` → x is likely number → use f64
- `x.length` → x is likely string or array → check further
- `x.foo` → x is an object with field foo → infer struct type
- `x()` → x is a function → use funcref

This is a pre-pass that narrows `any` to concrete types based on usage patterns. Not sound (could be wrong at runtime) but covers 90% of test262 patterns where the intent is obvious.

### Fallback
If inference conflicts (e.g., `x + 1` AND `x.length`), keep as externref. Only narrow when usage is unambiguous.

## Complexity: L

## Implementation Plan

(Author: architect, 2026-05-21. Per #743 this issue is technically
superseded by whole-program type-flow analysis, but #684 is the
narrower, ship-first version: a single-function intra-procedural
inference that doesn't require a call graph and can land in days,
not weeks.)

### Entry point

New module `src/checker/usage-inference.ts` exporting:

```ts
export function inferAnyVarTypes(
  fn: ts.FunctionLikeDeclaration,
  checker: ts.TypeChecker,
): Map<ts.Symbol, ValType>;
```

Invoked from `src/checker/index.ts` for every function-like during
the typed-AST build. Result stored on `TypedAST.anyInferredTypes`,
consumed by codegen via `ctx.anyInferredTypes`.

### Data structure changes

1. **Per-function usage map**: a transient `Map<ts.Symbol, UsageSet>`
   built during a single AST walk:
   ```ts
   interface UsageSet {
     arithmetic: boolean;       // x + 1, x * 2, x - n
     stringConcat: boolean;     // x + "lit" or "lit" + x
     propertyRead: Set<string>; // .length, .foo, ...
     called: boolean;           // x()
     indexed: boolean;          // x[i]
     comparedLT: boolean;       // x < y (suggests numeric)
     mutatedField: Set<string>; // x.foo = ...
   }
   ```

2. **No persistent state** — each function's inference is
   self-contained; output is `Map<ts.Symbol, ValType>` keyed by
   parameter or local symbol.

### Numbered algorithm

1. For each function-like node:
   1. Resolve every parameter/local whose TS type is `any` (or
      `unknown`).
   2. Walk the function body collecting `UsageSet` per symbol.

2. **Inference rules** (apply in order; first match wins):
   1. `usage.arithmetic && !usage.stringConcat && !usage.propertyRead`
      → f64.
   2. `usage.stringConcat && !usage.arithmetic` → native string.
   3. `usage.called` → funcref (extract signature from call-site arg
      types if all consistent).
   4. `usage.indexed && usage.propertyRead.has('length')` → array
      (element type per #746/#743 if available, else externref-vec).
   5. `usage.propertyRead.size > 0` → emit a sketch hidden class
      (defers to #746); for now leave as externref unless #746 has
      landed.
   6. Conflict (e.g. arithmetic AND propertyRead) → leave as
      externref.

3. **String concat heuristic**: `x + y` where y is a known string
   literal → x is string; where both unknown → can't decide, leave
   externref. Use `checker.getTypeAtLocation(y)` to disambiguate.

4. **Emit map**: only include symbols that resolved to a concrete
   type; absent entries fall through to existing externref path.

5. **Codegen consumption** — in `src/codegen/declarations.ts` (local
   declaration emission) and `src/codegen/index.ts` (parameter type
   emission), after the existing
   `mapTsTypeToWasm(checker.getTypeAtLocation(node), checker)` call
   check `ctx.anyInferredTypes.get(symbol)` and prefer that when the
   checker result is `externref` (i.e. `any`).

### Example

```js
function f(x) {
  return x * 2 + 1;
}
```

- Usage: arithmetic={true}, propertyRead={}, called=false.
- Rule 1 fires → `x: f64`.
- Emit: `(func $f (param $x f64) (result f64) ... f64.mul ... f64.add)`.

```js
function g(s) {
  return s.length;
}
```

- Usage: propertyRead={"length"}, indexed=false.
- Rule 4/5 — defers to #746 hidden class or string-vs-array
  ambiguity → leave externref for now (acceptable narrowing).

### Edge cases

- **Symbol used in only one place**: still infer if rule fires.
- **`x` reassigned to different type**: scan all assignments;
  collect into the same UsageSet. If reassignment types conflict →
  externref.
- **`x` captured by inner closure**: walk into closure; capture
  usage too. Mark for ref-cell wrapping if mutated.
- **`x = undefined`**: triggers union widening with the inferred
  type; reuse #1552 tagged-union sentinel if available, else
  externref.
- **Boolean inference**: `if (x)` + `x = true` → boolean. But `if
  (x)` alone is not strong evidence (any truthy works); require
  `===true`/`===false` or boolean assignment.
- **BigInt vs Number arithmetic**: `x + 1n` → bigint; `x + 1` →
  f64. The `n` suffix in the literal disambiguates.
- **Property reads on `this`**: not in scope — handled by class
  field types.
- **Generator yield / async await**: do not infer through await
  boundaries; the awaited value's type is opaque without #743.
- **Function called with mixed arg types** (`x(1); x("hi")`): leave
  funcref signature externref to avoid mis-inference.

### Test262 paths to watch

- `test/language/expressions/addition/*` — arithmetic vs string
  concat
- `test/built-ins/Math/*` — pure-numeric inference
- `test/language/statements/function/*`

Acceptance: measurable reduction in externref locals in emitted
wasm for the test262 corpus; no regression.

### Dependencies

- None blocking. Lands independently of #743.
- When #743 ships, #684 becomes a fast intra-procedural seeding for
  the inter-procedural fixed point; the two coexist.
- Property-read inference (rule 5) integrates with #746 once landed.

### Risks

- **Unsoundness on runtime types**: if the inference is wrong at
  runtime, the program traps. Mitigation: only infer when ALL uses
  are consistent; conflict → externref.
- **Behaviour change on edge JS**: gate behind `ctx.useUsageInfer`
  flag; default on after one week of CI soak.

## Resolution (2026-07-17, dev-684)

Shipped a **sound, conservative** first slice — narrows `any`/`unknown`-typed
function-**local** identifier bindings to an unboxed `f64` slot when every use is
*ToNumber-invariant*, eliminating the per-read `__box_number`/`__unbox_number`
round-trip.

### What landed

- New checker-layer module `src/checker/usage-inference.ts` (`UsageInference`
  class). Lives above codegen, so it may use the raw `ts.TypeChecker` freely
  (the oracle-ratchet gate scopes only `src/codegen/**`). Instantiated in
  `create-context.ts` as `ctx.usageInference`; codegen reads it through the
  single adapter `usageInferredLocalType(ctx, decl)` in
  `statements/variables.ts` — **zero** direct-checker growth in the backend
  (ratchet passes clean).
- Wired at the three authoritative local-slot minting sites so they agree: the
  `var` hoister (`hoistVarDecl`), the `let`/`const` pre-hoister, and
  `localTypeForDeclaration` (main + generator-spill paths).
- Gated by `useUsageInfer` (default **on**; `JS2WASM_USAGE_INFER=0` or
  `{ useUsageInfer: false }` restores the legacy boxed carrier).

### Soundness (why f64 is observationally equivalent)

`__unbox_number === Number()` (ToNumber). Storing the local as f64 coerces every
write via `Number(source)`, which matches the original value **iff every use
already applies ToNumber**. The classifier only accepts strictly-numeric
operators (`* / % - ** << >> >>> & | ^`, unary `- + ~`, `++`/`--`, matching
compound assigns), relationals with a statically-numeric other operand, and the
assignment target; it **defaults to bail** for everything else. Key exclusions
found and closed during implementation:

- **`+` / `+=` always bail** — they dispatch on the runtime type, so `x + 3` is
  string *concatenation* (`"5" + 3 === "53"`) when `x` is a string. A static
  number-hint on the other operand does not disambiguate `x`.
- **bigint bails** — a bigint operand/initializer means bigint arithmetic, which
  an f64 slot cannot represent (and mixing traps).
- **uninitialized default** — a hoisted `var` is NaN-seeded at entry
  (`ToNumber(undefined)`), not the wasm default 0; `let`/`const` require an
  initializer (their slot has no entry-init hook), else bail.
- **escapes bail** — `return x`, call arguments, `===`/`==`, truthiness,
  template interpolation, property/index, and **closure capture** all bail.

### Scope / follow-ups

Parameters (ABI-affecting, needs the #743 call graph), destructuring/for-of/in
bindings, module globals, and the `let x; x = …` (no-initializer) split form are
deliberately out of this slice.

## Test Results

`tests/issue-684.test.ts` — 36/36 pass. Covers representation (f64 slot, no
box/unbox, NaN-seeded var, flag-off boxed), narrowed semantics (mul/div/mod/pow/
bitwise/shift/unary/inc-dec/compound/string-ToNumber/NaN), soundness bails
(`+` concat, truthiness, escape, closure, bigint, return, relational-only), and
an on-vs-off differential battery. Regression batches (any-plus-string,
any-relational, coercion, closures, generators/spill, hoisting, number-arrays)
show **no new failures** — every failure reproduces identically with
`JS2WASM_USAGE_INFER=0`, confirming they are pre-existing and independent of this
change.
