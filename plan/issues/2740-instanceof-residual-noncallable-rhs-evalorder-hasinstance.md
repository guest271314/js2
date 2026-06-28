---
id: 2740
title: "[UMBRELLA] instanceof residual after #2702 — 5 deep gaps, split into #2763/#2764/#2765"
status: ready
sprint: current
created: 2026-06-27
updated: 2026-06-28
priority: medium
horizon: s
feasibility: hard
reasoning_effort: medium
task_type: planning
area: codegen
es_edition: ES3
language_feature: instanceof
goal: test262-conformance
parent: 2702
depends_on: []
children: [2763, 2764, 2765]
---
# #2740 — `instanceof` residual after #2702 (UMBRELLA — do not implement directly)

`#2702` delivered the core `OrdinaryHasInstance` ordering (step 3 before step 4)
and the non-object RHS `TypeError`. A verify-first investigation on 2026-06-28
(local sweep: **28 pass / 15 fail** in `test/language/expressions/instanceof/`)
found that the residual failures are **NOT instanceof-operator bugs** — the
operator semantics are correct. They are symptoms of **5 distinct deep feature
gaps**. The original "4 concrete bugs" framing mis-diagnosed where the failures
originate (e.g. the "null/undefined LHS" group is actually a `.prototype`
property-access trap on dynamic `Function(...)` values).

This issue is now an **umbrella / tracking** record. Do not implement it
directly — work the split sub-issues below.

## Split

| Sub-issue | Clusters | Routing | Tests |
|-----------|----------|---------|-------|
| **#2763** | (1) cross-realm `Object`/`Function` constructor identity in the dynamic instanceof path; (2) `.prototype` access on dynamic `Function(...)`/`new Function` values traps | SUBSTRATE / architect (folds into the value-rep / IR roadmap) | A2.1_T1, A2.4_T1, A2.4_T4, A6_T1, A6_T4 · A2_T6, A2_T2, A3_T1, A2_T5, A7_T1, A7_T3, A3_T2 |
| **#2764** | (3) `@@hasInstance` handler invoked at unknown-arity → `arguments.length` wrong (host method-bridge) | dispatcher half RESOLVED by #2213; **verified one-line residual** in `_instanceofResult` | symbol-hasinstance-invocation |
| **#2765** | (4) `Function.prototype` "prototype" getter + WasmGC array prototype chain; (5) undeclared-global read → `ReferenceError` (broad/risky) | hard (cluster 5 may be wont-fix) | prototype-getter-with-object · A2.1_T3 |

## Root-cause summary (full detail in each sub-issue)

1. **Cross-realm value-rep (#2763)** — `var O = Object; ({}) instanceof O` is
   `false` at runtime: `Object`/`Function` arrive in `_instanceofResult` as a
   *sandbox-realm* native fn (`target !== Object` host identity) and the `{}`
   LHS arrives as a real host object; the direct form only passes via static
   fold. `({}) instanceof this` (this = undefined) returns false instead of
   throwing. Plus an over-eager codegen static-throw for primitive-typed-but-
   reassignable RHS (`var O=0; (O=Object,…)`).
2. **`.prototype` on dynamic Function values (#2763)** — `Function(...)`/`new
   Function` now return real callables (the `runtime.ts` "lowers to undefined"
   comment is STALE), but reading `.prototype` off one traps "Cannot access
   property on null or undefined". This is the cluster mis-labeled "null/
   undefined LHS"; the null-deref is on `FACTORY.prototype`, not in instanceof.
3. **`@@hasInstance` arity (#2764)** — VERIFIED: #2213 fixed the dispatcher half
   (`emitClosureMethodCallExportN` now sets `__argc`); the residual is a verified
   one-liner bridging the handler at arity 1 in `_instanceofResult`.
4. **`Function.prototype` getter + array proto chain (#2765)** — hard.
5. **undeclared-global → ReferenceError (#2765)** — broad cross-cutting semantic;
   may be wont-fix.

## Out of scope
BigInt-RHS and `with`-bound RHS instanceof tests (blocked clusters, sprint 67
deferred list).

## Notes
- Spec: ES2023 §13.10.2 `InstanceofOperator`, §7.3.20 `OrdinaryHasInstance`.
- No-regression bar for every sub-issue: the 28 instanceof tests currently green
  must stay green.
