---
id: 2809
title: "[SENIOR-DEV ONLY] undefined[] representation conflation — acorn's void-0 evolving array vs genuine undefined[]"
status: ready
assignee: ttraenkler/unassigned
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
created: 2026-06-29
task_type: bugfix
area: codegen
language_feature: value-representation
goal: acorn-dogfood
related: [2806, 2801, 2379]
depends_on: []
blocks: [2801]
architect_spec: candidate
---

# #2809 — `undefined[]` representation conflation: acorn evolving-array (refs) vs genuine `undefined[]` (numeric)

**Carved from #2806.** #2806 took compiled-acorn `parse("foo(bar,baz)").arguments`
from `[0,0]` to the correct `[Identifier, Identifier]` end-to-end — but the fix's
third site (the `resolveWasmType` Array branch) is **load-bearing for acorn yet
over-broad for test262**, causing a real merge_group regression. This issue carves
out the underlying **representation-design decision** for an architect spec.

## TL;DR for the architect

Two distinct things share the TypeScript type `Array<undefined>` and must lower
**differently**:

- **acorn's evolving array** — `var elt = (void 0); elt = <nodeRef>;
  elts.push(elt); return elts`. The `void 0` expression pins `elt` to type
  `undefined`, so `elts` and the function's return type infer as `undefined[]`,
  but the runtime values are **references** (AST nodes). This MUST be an
  **externref** vec, or the refs coerce to `0`.
- **genuine `undefined[]`** — `Array(undefined, undefined)`, `[undefined,
  undefined]`, sparse `[,,,]`. These hold real `undefined` VALUES and today
  lower to **numeric** (i32/f64) vecs with the undefined sentinel, and pass
  test262.

**Core design question:** can we route acorn's evolving array to externref via
the **void-0 signal** (at element-type AND return-type inference) so genuine
`undefined[]` stays numeric — WITHOUT the blunt global `resolveWasmType`
override? If not, the fallback is to make `undefined[]` **uniformly**
externref-boxed-undefined across every construction/access/method path.

## Background: the #2806 fix (3 sites)

The #2806 root cause is the `var x = (void 0)` idiom: the `void 0` expression pins
the binding to TS type `undefined` (unlike `= undefined`/`= null`/no-init, which
TS treats as evolving-any → externref), and `resolveWasmType(undefined)` is a
numeric (i32) slot, so a later REFERENCE assignment/push/return is coerced to `0`.
The landed fix (branch `issue-2806-untyped-array-ref-vec`, PR #2284) has three
sites:

1. **Void-expr slot** (`varBindingNeedsExternrefForUndefined` in
   `src/codegen/index.ts`, used by `hoistVarDecl` + `localTypeForDeclaration` in
   `src/codegen/statements/variables.ts`): a `var x = (void 0)` binding gets an
   externref slot. NARROW (void-EXPRESSION only — a bare `undefined`-typed binding
   like `const afterA = obj.a` after `delete` must stay numeric for the f64-sNaN
   delete sentinel, #1112). **CLEAN — keep.**
2. **`inferArrayVecType`** (`statements/variables.ts`): undefined/void/null
   push-value types no longer pin the array's element kind to a numeric vec
   (treated like `any`). Makes the evolving LOCAL `elts` an externref vec.
   **CLEAN — keep.**
3. **`resolveWasmType` Array branch** (`src/codegen/index.ts` ~11610): a purely
   `undefined`/`void` array element → externref vec. **REQUIRED for acorn (the
   function RETURN type of `parseExprList` is `undefined[]` and must match the
   externref local), but OVER-BROAD — it is the regression source.**

Sites #1 + #2 are the clean foundation and should be preserved by any solution.

## The merge_group regression (REAL, net-positive, ratio-gated)

PR #2284 passed PR-level checks but was auto-parked on the merge_group
"check for test262 regressions" required gate. Delta (from the
`test262-merged-report` artifact diffed against baseline):

```
pass  34266 → 34273  (+7 net)
Regressions (pass→other): 5   Improvements (other→pass): 12
GATE FAIL: regression ratio 41.7% (5/12) ≥ 10% limit
Regression categories: wasm_compile 2, null_deref 1, assertion_fail 1, illegal_cast 1
```

The change is **net-positive** (+7 pass, 12 real improvements from the void-0
fix); the gate fails on the **ratio**, and the 5 regressions are **real** (not
drift — confirmed by local reproduction).

### The 5 regressed tests

1. `test/built-ins/Array/S15.4.1_A2.1_T1.js` — `Array(undefined, undefined).length`
   returns 0, expected 2.
2. `test/built-ins/Array/S15.4.2.1_A2.1_T1.js` — `new Array(undefined, undefined)`
   → invalid wasm (`array.new_fixed[0] expected type`).
3. `test/built-ins/Array/prototype/sort/S15.4.4.11_A1.3_T1.js` —
   `new Array(undefined, undefined).sort()` → invalid wasm.
4. `test/built-ins/Array/prototype/reduceRight/15.4.4.22-8-c-4.js` — sparse
   `[, , , ]` → null_deref.
5. `test/language/module-code/top-level-await/syntax/for-in-await-expr-this.js` —
   illegal_cast. **Likely drift/collateral, NOT Array** — verify against another
   PR's regression list / a clean re-merge.

### Mechanism of the regression

Site #3 makes `Array<undefined>` an externref vec on the **TYPE** side (the
variable's declared type, `.length` access, the function return type). But the
**CONSTRUCTION/access** side still builds **numeric (i32) vecs**:

- `compileArrayConstructorCall` (`Array(...)`, `literals.ts:3944`) computes the
  element via `resolveWasmType(undefined)` [SCALAR] = i32 — NOT the Array branch
  — so it builds an i32 vec while consumers resolve the value's
  `Array<undefined>` type to externref → mismatch (wrong `.length`,
  `array.new_fixed` validation failure).
- `new Array(...)` (new-super.ts path) — same, separately.
- Sparse `[, , ,]` holes — externref vec but hole/access path null-derefs.
- `.sort()` — rebuilds the backing array, same mismatch.

The plain array **literal** `[undefined, undefined]` already defaults all-undefined
to externref (literals.ts ~3219), so it is CONSISTENT and was NOT regressed —
which is the existence proof that uniform externref CAN work, just not yet wired
through the builtins/sparse/method paths.

### Why #3 can't simply be reverted

Verified: reverting #3 makes all 4 Array tests pass **but regresses real acorn back
to `[0,0]`** — `parseExprList`'s return type `undefined[]` resolves to a numeric vec
while the local `elts` is an externref vec, and `return elts` coerces every pushed
ref to `0`. #3 is the only site that currently fixes the return type. So the
acorn win and the test262 Array correctness are coupled through `undefined[]`.

## Prototype already explored (in branch worktree)

Aligning `compileArrayConstructorCall` with #3 (a `pureUndefinedVoidElem →
externref` branch) **fixed** `Array(undefined,undefined).length === 2` and left
numeric arrays (`Array(0,1,0,1)`) untouched — but `new Array(...)`, sparse holes,
and sort each still need the same alignment. That spreading across ~4–5
construction/method paths is the **reference_2379 "representation-scale" hazard**:
a representation change that can't be safely validated without full merge_group.

## Options (with assessment)

- **(a) Uniform `undefined[]` → externref-boxed-undefined** across every
  construction/access/method path (literal ✓ already; + `Array()`, `new Array`,
  sparse holes, sort, reduceRight, indexed read/write). More spec-correct
  (undefined boxed as externref, not an f64 sentinel) and keeps the acorn win.
  But broad blast radius; needs 1–2 merge_group rounds to validate. **The correct
  end-state if the void-0 signal can't be exploited.**
- **(b) Surgical func-result-type adaptation** — drop global #3; instead adapt
  `parseExprList`'s function RESULT TYPE to externref at body-end (the
  `func.typeIdx` reassignment infra exists, `function-body.ts:126`) so test262
  undefined-arrays stay numeric. **REJECTED by tech-lead** — funcIdx/caller-order
  desync risk (#1257 class); a hack.
- **(c) Split** — drop #3, land the clean #1 + #2 (real improvements, no Array
  break) now, re-spec the return-type later. **REJECTED by tech-lead** — defers
  the acorn goal.

**Preferred direction (architect to confirm):** a principled inference fix —
make acorn's evolving array infer as `any[]`/evolving-any (→ externref) via the
**void-0 signal**, at BOTH the array-element-type and the function-return-type
inference, so genuine `undefined[]` stays numeric and there is NO test262
regression and NO blunt global override. If that inference path is not feasible,
fall back to (a). Either way, preserve #1 + #2.

## Acceptance

- Compiled-acorn `parse("foo(bar,baz)").arguments` → `[Identifier, Identifier]`
  (the #2806/#2801 milestone) stays green.
- All 4 `built-ins/Array/**` regressions above pass; genuine `undefined[]` /
  `Array(undefined,...)` / sparse arrays keep correct length + element semantics.
- Full `merge_group` + standalone-floor green (ratio < 10%, no bucket > 50),
  watch `built-ins/Array/**` + TypedArray.

## Pointers

- Branch with the full #2806 fix + the `compileArrayConstructorCall` prototype
  to build on / cherry-pick: `issue-2806-untyped-array-ref-vec` (PR #2284,
  PARKED — do not unpark until this is resolved).
- Repros banked in that worktree's `.tmp/`: `repro-variants.mjs`,
  `repro-voidinit.mjs`, `callargs3.mjs`/`elemdbg.mjs` (acorn), `arrundef.mjs`
  (the Array-undefined construction cases).
- Memory: `reference_2379_new_array_n_boxed_any_elem_rep` /
  `reference_2379_new_array_n_arraymethod_invalid_cast` — the representation-scale
  precedent.
