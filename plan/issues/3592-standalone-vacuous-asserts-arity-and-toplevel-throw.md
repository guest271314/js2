---
id: 3592
title: "Silent wrong answers: top-level `throw` dropped in every non-WASI lane; under-applied calls through `__apply_closure` never happen (standalone)"
status: in-progress
sprint: current
priority: high
horizon: m
feasibility: hard
goal: standalone-gap
assignee: ttraenkler/senior-dev-vacuity
created: 2026-07-25
# RC2 only: the widening builder lives in the (non-god-file) closure-exports.ts,
# but its call site + import still add 8 LOC to the object-runtime.ts god-file.
loc-budget-allow:
  - src/codegen/object-runtime.ts
---

## Problem

Two independent **silent wrong answers** — not harness noise. Both were MEASURED
verify-first on `origin/main` @ `7652f033` on 2026-07-25, and **both refute the
description they were dispatched with**.

### RC1 — a bare top-level `throw` statement is silently dropped (ALL non-WASI lanes)

`src/codegen/declarations.ts:1522` collects a top-level `ThrowStatement` into
`__module_init` **only** under `--target wasi`:

```ts
if (ts.isThrowStatement(stmt)) {
  if (ctx.wasi) ctx.moduleInitStatements.push(stmt);
  continue;
}
```

#2968 added the WASI arm and deliberately left host/standalone alone ("their
pre-existing top-level-throw drop is out of scope"). The consequence is that a
module whose only statement is `throw new Test262Error("HELLO")` **runs to
completion and scores PASS**.

**Correction to the dispatch premise:** this is **not** standalone-specific — the
**JS-host lane drops it too**. Measured A/B (`.tmp/probe-harness.mts`, real
`assembleOriginalHarness` prefix, `deferTopLevelInit`, `__module_init` invoked
after `setExports`):

| lane       | bare top-level `throw Test262Error` |
| ---------- | ----------------------------------- |
| standalone | RAN-TO-COMPLETION → scored **pass** |
| host       | RAN-TO-COMPLETION → scored **pass** |

Without the harness prefix the drop is even more visible: a module whose sole
statement is `throw` emits **no `__module_init` export at all**.

**Correction to the expected direction:** this does **not** inflate the floor.
Exact corpus footprint, TS-parser scan of every non-`_FIXTURE` test262 file
(`.tmp/scan2.mts`): **40 files** carry a top-level ThrowStatement, out of 19,202
that mention `throw` at all. Almost every one is a `negative:` test that
currently scores **FAIL** ("expected Test262Error") _precisely because the throw
never happens_. So the expected flip direction is **fail→pass**.

### RC2 — an under-applied call through `__apply_closure` silently does not happen (standalone/WASI)

`fillApplyClosure` (`src/codegen/object-runtime.ts`) dispatches on the **dynamic
argument count** alone:

```
n = i32(__extern_length(args)); if n==0 → __call_fn_method_0 … if n==8 → __call_fn_method_8; else undefined
```

but `emitClosureMethodCallExportN` (`src/codegen/closure-exports.ts:498`) only
carries closures whose declared formal count is `<= arity`:

```ts
if (info.paramTypes.length > arity) continue;
```

So dispatching an **arity-3** closure at **n = 2** matches no arm, falls through
to the bridge's undefined sentinel — and **the call silently does not happen**.

That is the exact shape of the entire test262 assert harness:
`assert.sameValue(found, expected, message)` is virtually always invoked as
`assert.sameValue(a, b)`.

**Correction to the dispatch premise:** the reported symptom was
"dynamic-string `sameValue` false-positive, while `assert.sameValue(1,2)`
correctly FAILS". That is wrong in both halves. It is not a string bug, and
`assert.sameValue(1,2)` is vacuous too. Measured (numeric channel — the body
records the outcome into a module global read back through an exported
`probeQ()`, so nothing depends on exception rendering; `.tmp/probe5.mts`,
`.tmp/probe7.mts`):

| standalone call                            | args/formals | outcome                     |
| ------------------------------------------ | ------------ | --------------------------- |
| `assert(false)`                            | 1/2 (direct) | threw — CORRECT             |
| `assert.sameValue(1, 2)`                   | 2/3          | returned normally — VACUOUS |
| `assert.sameValue("a", "b")`               | 2/3          | returned normally — VACUOUS |
| `assert.sameValue("" + true, "SHOWME")`    | 2/3          | returned normally — VACUOUS |
| `assert.sameValue(1, 2, "msg")`            | **3/3**      | threw — **CORRECT**         |
| `assert.notSameValue(1, 1)`                | 2/3          | returned normally — VACUOUS |
| `assert.throws(TypeError, function () {})` | 2/3          | returned normally — VACUOUS |

Isolation controls that pin it to _under-application on the closure-carried
property dispatch path_ and nothing else:

| control                                           | standalone  | host    |
| ------------------------------------------------- | ----------- | ------- |
| fn-static 3 formals, called with **3** args       | CORRECT     | CORRECT |
| fn-static 3 formals, called with **2** args       | **VACUOUS** | CORRECT |
| fn-static 3 formals, `(1, 2, undefined)` explicit | CORRECT     | CORRECT |
| fn-static 2 formals, 2 args                       | CORRECT     | CORRECT |
| fn-static 1 formal, **0** args                    | **VACUOUS** | CORRECT |
| PLAIN function, 3 formals, 2 args                 | CORRECT     | CORRECT |
| object-literal method, 3 formals, 2 args          | CORRECT     | CORRECT |

The **JS-host lane already fixed exactly this**, in JS, in #2623 P-7 / B-1:
`_wrapWasmClosureUnknownArity` dispatches at `max(args.length,
__closure_arity(fn))` rather than at the highest emitted dispatcher. The
**in-Wasm** bridge never got the same treatment.

**`verifyProperty` is a SEPARATE root cause — measured, not assumed.** The
lead's hypothesis was that the `verifyProperty`-past-its-a1-gate vacuity is this
same arity bug. It is not: with the RC2 fix ON and OFF, `verifyProperty(Math.abs,
"name", {…writable: TRUE})` (a deliberately wrong expectation) is **identically
non-throwing** in both arms (`.tmp/probe9.mts`). The arity fix un-vacuums the
`assert.*` family only.

## Measurements

### RC1 — exhaustive (population, not a sample)

The exposed population is exactly the 40 files carrying a top-level
`ThrowStatement`, so this is a **complete census**, not an estimate. Local-vs-local
A/B, same runner (`runTest262File`), same process, only the collection toggled:

| lane           |   n | pass→pass | **fail→pass** | fail→fail | CE→CE | **pass→fail** | changed signatures |
| -------------- | --: | --------: | ------------: | --------: | ----: | ------------: | -----------------: |
| **standalone** |  40 |        26 |         **5** |         2 |     7 |         **0** |                  1 |
| **host**       |  40 |        26 |         **5** |         3 |     6 |         **0** |                  2 |

The five gainers are the same in both lanes:
`language/module-code/eval-self-abrupt.js`,
`language/line-terminators/comment-single-{cr,lf,ls,ps}.js`.

The single standalone signature change (`language/module-code/eval-rqstd-abrupt.js`,
`expected TypeError` → `uncaught Wasm-GC exception (non-stringifiable payload)`)
lands in an **already-classified** `STANDALONE_ROOT_CAUSE_BUCKETS` entry
(`scripts/build-test262-report.mjs:782`), so the #3439 hard-0 unclassified gate is
not at risk.

**Net: +5 standalone, +5 host, 0 regressions.**

### RC2 — random sample, honest split

Local-vs-local A/B, standalone lane, **N = 200 uniformly sampled test262 files**
(seed `20260725`, `.tmp/ab.mts`), same runner, same process, only the widening
toggled. **These are sample counts. They are deliberately NOT scaled to a corpus
number.**

| transition                  |  count |
| --------------------------- | -----: |
| skip→skip                   |     39 |
| compile_error→compile_error |      5 |
| pass→pass                   |     85 |
| fail→fail                   |     56 |
| **pass→fail**               | **15** |
| fail→pass                   |      0 |
| same-status signature drift |      0 |

**15 of the 100 tests that passed standalone before the fix flip to fail** — i.e.
**15 % of the sampled standalone pass set was vacuous through this one
mechanism**. Every flip cites a harness assertion at the failing line
(`assert.sameValue` / `assert.throws` / `assert.compareArray` / `throw new
Test262Error()`), so these are **honest flips**, not collateral.

New-signature classification of the 15:

| signature family                                                      | count | classified?                                      |
| --------------------------------------------------------------------- | ----: | ------------------------------------------------ |
| `uncaught Wasm-GC exception (non-stringifiable payload)`              |    11 | YES (existing bucket)                            |
| `Test262:AsyncTestFailure:Test262Error: …SameValue…`                  |     3 | needs check                                      |
| `RuntimeError: illegal cast … ← __call_fn_method_3 ← __apply_closure` |     1 | **NEW — invalid-Wasm class, not an honest flip** |

That last one is the one real hazard the fix introduces: a missing formal is now
supplied as the `undefined` sentinel, and a callee whose param was inferred to a
concrete WasmGC ref type **traps** on it instead of seeing `undefined`. Before
the fix the call simply never happened. Both are wrong; the trap is a different
failure class and must be separated from the honest flips per the F1 recipe.

## Decision (scoping)

**RC1 lands now** (this PR): exhaustively measured, purely positive, zero park
risk, ~10 lines.

**RC2 does NOT land in this budget window.** A 15 %-of-passing de-inflation is a
deliberate honest-floor landing (park = measurement; separate honest-flips from
invalid-Wasm; cluster-route every new signature into
`STANDALONE_ROOT_CAUSE_BUCKETS`; bump `ORACLE_VERSION` if verdict logic changes)
— see `reference_f1_honest_floor_deinflation_landing_recipe` and #3523. That is
an XL landing, not the M this task was sized for. The fix is complete and
verified on a **ready branch**.

## Implementation

### RC1 (in this PR)

`src/codegen/declarations.ts` — drop the `ctx.wasi` gate so a top-level
`ThrowStatement` is collected into `__module_init` in every lane.

### RC2 (ready branch `issue-3585-apply-closure-arity`, NOT merged)

- `src/codegen/closure-exports.ts` — extract `collectClosureArityEntries` and add
  `buildClosureArityProbe(ctx, valueLocal, anyLocal, funcLocal)`: the **inline**
  twin of the `__closure_arity` export, leaving the declared formal count (or
  `-1`) on the stack.
- `src/codegen/object-runtime.ts` — `fillApplyClosure` widens the dispatch index
  to `max(argc, declaredArity)` before the arity switch.

**Why inline rather than `call __closure_arity`:** the export is minted at
`index.ts:3975`, _after_ `fillApplyClosure` runs at `:3817`. Minting a function
inside that finalize window is the #1839/#117/#1886 late-registration
index-shift hazard that `fillApplyClosure`'s own "S1 pulls no new machinery"
carve-out exists to avoid. Inlining shifts nothing.

**Why widen rather than pad the arg vector:** at `N === closureArity` the #820l
argc/extras plumbing takes its `arity <= closureArity` branch (`__argc =
closureArity`, `__extras_argv = null`) — byte-for-byte what an arity-matched call
sets, so `arguments.length` reflection is unchanged. Padding to the highest
dispatcher would populate `__extras_argv` with synthetic `undefined`s, which is
the exact regression #2623 P-7 was written to remove.

Non-closures probe as `-1`, so `max` leaves `n` untouched: over-application,
exact-arity and not-a-function are byte-identical, and modules with no closures
emit no probe at all. The host/GC lane is untouched — `__apply_closure` is only
ever reserved under standalone/WASI.

## Acceptance criteria

- [x] RC1: top-level `throw` executes in host + standalone (measured, both lanes)
- [x] RC1: exhaustive A/B over the complete 40-file exposed population, 0 regressions
- [x] RC2: root cause isolated to arity under-application, with host/plain-fn/object-method/explicit-`undefined` controls
- [x] RC2: `verifyProperty` measured as a SEPARATE root cause (identical A/B arms)
- [x] RC2: honest pass/fail split reported with denominators, not extrapolated
- [ ] RC2: honest-floor landing (cluster-route the 3 async signatures + the illegal-cast trap, then land per the F1 recipe)

## Follow-up

1. **Land RC2 deliberately** as an honest-floor de-inflation (XL).
2. **Fix the `undefined`-into-a-typed-formal trap** surfaced by RC2
   (`illegal cast … ← __call_fn_method_N ← __apply_closure`): a missing formal
   must read as `undefined`, not trap, when the callee's param lowered to a
   concrete WasmGC ref.
3. **`verifyProperty` vacuity is unexplained** and is NOT the arity bug — it needs
   its own investigation (4,735 files call it).
