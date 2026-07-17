---
id: 2948
title: "standalone: chained dynamic add in lifted foreign bodies yields NaN (any-add result cannot feed another any-add)"
status: done
created: 2026-07-02
updated: 2026-07-17
completed: 2026-07-17
assignee: ttraenkler/opus-3
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: eval
goal: runtime-eval
parent: 2860
related: [2923, 2924, 1629]
---

## Verification — chained any-add fixed on main; typeof layer split to #3346 (2026-07-17, opus-3)

Re-verified against current `origin/main`: the chained-any-add NaN in lifted
foreign bodies (criteria 1 & 2) **no longer reproduces** — the #745 tagged-union
value-rep substrate work (carrier-agnostic strict-eq / truthiness / concat /
arithmetic for the `$AnyValue` union) closed the gap. All standalone, host-free,
return **6**:
- `eval("function q(a,b,c){return a+b+c} q(1,2,3)")` → **6**
- `new Function("a","b","c","return a+b+c")(1,2,3)` → **6**
- `new Function("a","b","c","var t=a+b; return t+c")(1,2,3)` → **6**
- `new Function("a","b","c","return a+(b+c)")(1,2,3)` → **6**

Locked with `tests/issue-2948.test.ts` (5 standalone host-free cases). This PR is
test + doc only — **byte-inert** to the compiler (no `src/` change).

**Criterion 3 (typeof-boxed-param) is independent and still broken** — split to
**#3346**. `new Function("a","return typeof a")(5)` returns `"undefined"` not
`"number"` on main; the arithmetic controls prove the boxed value is usable, so
the defect is in the standalone `typeof` rep classifier, not the lift. The
#2924 acceptance-3 `return a+b+c` re-enable was validated-working but deferred
here to avoid entangling with two **pre-existing, unrelated** failures in
`tests/issue-2924.test.ts` (`acceptance 5: new Function("return")()` and the
no-arg `new Function()` case, both red on pristine main — flagged separately).


# #2948 — standalone: chained any-add in lifted foreign bodies yields NaN

## Problem

In a **lifted foreign body** (a `ts.createSourceFile` splice with no checker
bindings — the #2923 constant-`eval` lift and the #2924 constant-`Function`
compile-away), parameters degrade to externref (`any`). A single dynamic add of
two such params works, but the **result of one any-add cannot feed another
any-add** — the second add sees an operand rep it cannot ToNumber and produces
NaN. Standalone only; host (gc) mode computes correctly.

Repro (all standalone, all return NaN, expected 6):

```ts
eval("function q(a,b,c){return a+b+c} q(1,2,3)"); // eval lift
new Function("a", "b", "c", "return a+b+c")(1, 2, 3); // #2924
new Function("a", "b", "c", "var t=a+b; return t+c")(1, 2, 3); // via local
new Function("a", "b", "c", "return a+(b+c)")(1, 2, 3); // grouping
```

Control (works): `a+b` (2 operands), `a+1` (param + literal), and the identical
shapes in host mode. Params themselves arrive intact (`return a/b/c` each pass).

## Root-cause hypothesis

The standalone any+any add lowers to a helper returning a value whose rep
(boxed struct tag / unboxed f64) the SECOND add's operand classification does
not recognize — same value-rep substrate class as
[reference_1629b_boxed_primitive_typeof_eq_layers] (a `typeof` on a marshalled
boxed-number param also misreports in these bodies — likely the same layer).

## Acceptance criteria

- [ ] `eval("function q(a,b,c){return a+b+c} q(1,2,3)") === 6` standalone.
- [ ] `new Function("a","b,c","return a+b+c")(1,2,3) === 6` standalone
      (the #2924 acceptance-3 exact shape — re-enable it in
      `tests/issue-2924.test.ts` when this lands).
- [ ] `new Function("a","return typeof a")(5) === "number"` standalone
      (or split into its own issue if the typeof layer proves independent).

## Notes

Found while landing #2924 (probe series `.tmp/nf-probe*.mts`, dev-evalf,
2026-07-02). Not #2924-caused: the eval-lift control fails identically on main.
Umbrella: #2860 (standalone-vs-host gap). Goal: `runtime-eval`.
