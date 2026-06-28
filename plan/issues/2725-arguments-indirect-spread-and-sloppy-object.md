---
id: 2725
title: "arguments residual: spread args in indirect/aliased calls + sloppy-mode arguments-object identity (.callee/.constructor/hasOwnProperty)"
status: ready
sprint: Backlog
goal: test262-conformance
feasibility: medium
depends_on: []
priority: medium
es_edition: multi
language_feature: arguments-object
task_type: bug
created: 2026-06-26
updated: 2026-06-28
---

# #2725 — arguments residual: indirect-call spread + sloppy-mode arguments-object identity

Split out from **#2704** (which fixed the dominant case: `arguments.length` /
`arguments[i]` on _non-spread_ aliased / indirect method calls — the
multi-funcref dispatch path now plumbs `__argc` / `__extras_argv`). Two distinct
residuals remain, each a separate, deeper change:

## (A) Spread args in an indirect / aliased call (~5 tests)

The **direct** method-call path already handles spread + `arguments.length`
correctly (`obj.m(42, ...[1], ...arr)` → `arguments.length === 4`). The
**indirect** path (`var ref = obj.m; ref(42, ...[1], ...arr)`) does NOT: it
compiles each `expr.arguments[i]` as a plain expression and builds a
compile-time-fixed extras list, so a `SpreadElement` (especially a runtime array
`...arr`) is mis-counted — observed `arguments.length === 3` (want 4),
`arguments[2] === NaN` (want 2).

Fixing this requires the indirect-callable dispatch in
`compileCallExpression` (`src/codegen/expressions/calls.ts`, the
`__callable_param` / multi-funcref branch) to expand spread arguments — building
the args/extras at **runtime** for non-literal spreads and setting `__argc`
from the runtime length, mirroring the direct path's spread machinery.

Failing test262 (baseline 2026-06-26):

```
test/language/arguments-object/async-gen-meth-args-trailing-comma-spread-operator.js
test/language/arguments-object/cls-decl-async-gen-meth-args-trailing-comma-spread-operator.js
test/language/arguments-object/cls-decl-async-gen-meth-static-args-trailing-comma-spread-operator.js
test/language/arguments-object/cls-expr-async-gen-meth-args-trailing-comma-spread-operator.js
test/language/arguments-object/cls-expr-async-gen-meth-static-args-trailing-comma-spread-operator.js
```

## (B) Sloppy-mode arguments-object identity (~7 tests)

The current `arguments` object is a simplified vec-backed value; it does not
expose the real object surface that ES §10.4.4 mandates:

- `arguments.callee` (the executing function object)
- `arguments.constructor` / `arguments.constructor.prototype === Object.prototype`
  (the `[[Prototype]]` is `Object.prototype`)
- `arguments.hasOwnProperty("length")` (own `length` data property)

These probe the arguments object _as a real Object_, so they need the arguments
object to carry an Object prototype + a `callee` slot + own-property semantics —
an arguments-object _representation_ change, not the argc plumbing #2704 fixed.

Failing test262 (baseline 2026-06-26):

```
test/language/arguments-object/S10.6_A2.js     (arguments.constructor.prototype === Object.prototype)
test/language/arguments-object/S10.6_A3_T1.js
test/language/arguments-object/S10.6_A3_T4.js
test/language/arguments-object/S10.6_A4.js     (arguments.callee === fn)
test/language/arguments-object/S10.6_A5_T1.js  (arguments.hasOwnProperty("length"))
test/language/arguments-object/S10.6_A5_T3.js
test/language/arguments-object/S10.6_A5_T4.js
```

Related: **#1726** (mapped arguments exotic descriptor semantics, §10.4.4) — (B)
is the unmapped/identity side, distinct from #1726's mapped-descriptor side.

## Acceptance criteria

- (A) the 5 spread tests above flip to pass (indirect-call spread is counted /
  exposed in `arguments` identically to the direct path).
- (B) the 7 `S10.6_*` tests above flip to pass (arguments object exposes
  `callee`, `Object.prototype` chain, and own `length`).
- No regression in `arguments-object/` currently-passing tests. Full CI green.

(A) and (B) are independent; either may be sliced separately.

## Verify-first findings & re-scope (2026-06-28)

Verified against current `origin/main` (post-#2210/#2211) via the real worker
harness (`runTest262File`) and a minimal `compile`+`buildImports` repro.

### Baseline drift — 3 of the 12 already PASS; 9 genuine fails

The 2026-06-26 baseline is stale. Current true state (host/gc lane):

- **(A) — all 5 FAIL** (genuine).
- **(B) — only 4 FAIL**: `S10.6_A3_T4`, `S10.6_A4`, `S10.6_A5_T3`, `S10.6_A5_T4`.
  `S10.6_A2`, `S10.6_A3_T1`, `S10.6_A5_T1` now **PASS** (drop them from scope).

### (A) root cause — NOT async-gen-specific; it is generic indirect-call spread

Minimal repro isolates it cleanly (a plain sync method, no async/gen):

```
var arr=[2,3]; var obj={ method(){ return arguments.length } };
obj.method(42, ...[1], ...arr)        // DIRECT  → 4  (correct)
var ref=obj.method; ref(42,...[1],...arr) // INDIRECT → 3  (WRONG, want 4)
```

So the 5 async-gen-meth test files just _surface_ a generic
indirect-call-spread arguments-count bug; the fix is **not** in the async-gen
CPS path. The indirect `ref(...)` dispatch sets `arguments.length` from the
**syntactic** arg count (3) without runtime spread-expansion.

**Caveat for the implementer — the argc path is multi-armed and unconfirmed.**
Instrumenting `emitClosureCallArgcExtras` (calls.ts) and `emitSetArgc`
(calls.ts) showed **neither fires** for this `ref(...)` call, and
`maybeSetArgcForKnownCall` (nested-declarations.ts:1725) only sets `argc =
min(syntactic, paramCount)` and builds **no** `__extras_argv` — yet for a
0-param method that path would yield 0, not the observed 3. So a _third_ argc/
arguments-materialization arm produces the `3` and was not pinned down; the
implementer must first instrument to find the exact dispatch arm for an
identifier-callee resolved-funcref call before plumbing the spread-aware
`emitSetExtrasArgv` (nested-declarations.ts:1767 — which ALREADY does runtime
spread-expansion, #2202) + correct argc into it.

### BLOCKER — must build on the post-#2213 `__argc` convention

#2213 (bind dev) CHANGED the dispatcher `__argc` convention (fixed a latent HOF
over-arity `arguments.length` double-count to match V8). As of this writing
#2213 has **not landed** on `origin/main`. (A) MUST be implemented against the
post-#2213 convention and re-verified after it lands — do not build on the
pre-#2213 machinery. This is why (A) is parked here rather than shipped now.

### Re-scope

- **(A) — focused, dev-scoped, BLOCKED on #2213.** Plumb the existing
  spread-aware extras/argc setup into the indirect resolved-funcref dispatch
  arm. Pick up after #2213 lands; re-verify the counts against the new
  convention before enqueuing.
- **(B) — broad, senior/architect-scoped — carve to its own issue.** The
  arguments-object _representation_ change (own settable `length` + DontDelete,
  `callee` slot, `Object.prototype` chain). **Cross-link:** (B) and the
  instanceof cluster's **#2740 cluster-3** (`emitClosureMethodCallExportN` never
  sets `__argc`/`__extras_argv`) are BOTH arguments/argc-plumbing gaps in
  non-primary dispatch arms — a senior should unify the arguments-materialization
  machinery across all arms, and must avoid colliding with the #2740 cluster-3
  sub-issue the instanceof dev is filing. (B) was to be allocated its own id via
  `claim-issue.mjs --allocate` but the orphan-ref was contended at carve time;
  carve it next.
