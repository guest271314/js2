---
id: 2959
title: "Standalone: native `new Promise(executor)` — retire the unconditional Promise_new host import"
status: done
assignee: sendev-promise-exec2
completed: 2026-07-03
sprint: 69
created: 2026-07-02
updated: 2026-07-03
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: promises
goal: standalone-mode
related: [2867, 1326, 2895, 2918]
origin: "2026-07-02 July Fable audit §2/§4 (largest single promise gap; #2867 Phase-1E open item promoted to its own dispatchable slice)"
---

# #2959 — the executor pattern always leaks a host import

## Problem

`new Promise((resolve, reject) => …)` unconditionally lowers to the
`Promise_new` host import — there is no native branch
(`src/codegen/expressions/new-super.ts:2759-2778`, re-verified 2026-07-03).
Everything downstream of the executor pattern (a huge share of test262
async tests and real-world code) is therefore host-bound even though the
whole rest of the carrier ($Promise struct, `__promise_resolve_value`
recursive assimilation, `__promise_reject`, microtask ring, native
`.then/.catch`, `Promise.all/race`) is already native. The audit ranks this
the highest-leverage single promise slice.

## Approach

Add an `isStandalonePromiseActive(ctx)` branch at the new-super.ts lowering
site:

1. Allocate a pending `$Promise`.
2. Synthesize the `resolve` / `reject` closures over the existing
   `__promise_resolve_value` / `__promise_reject` helpers (resolve must go
   through the assimilation path so a promise-resolved-with-a-promise
   chains, and both must be no-ops after the first settle — the
   already-settled guard exists in the helpers; VERIFIED, see below).
3. Invoke the executor synchronously (spec: it runs before `new Promise`
   returns); an executor throw before settle ⇒ reject with the exception
   (route via the throw→reject wiring from #2867 Gap 2).
4. Return the `$Promise`.

Closure plumbing is the risk: the two settle closures capture the promise
— use the standard ref-cell / func-ref-wrapper capture machinery, no
bespoke path.

## Acceptance criteria

- Executor programs (resolve-sync, resolve-async-via-then, reject, throw,
  double-settle-ignored, resolve-with-thenable) behave to spec on
  `--target wasi`, zero `env::` imports in the emitted binary.
- Gate scope matches the carrier gate (wasi now; widens with #2867
  slice 1d — do not pre-widen, the −601 lesson).
- Host mode byte-unchanged; host-free floor strictly up (this flips a
  large pass-but-leaky cohort).

---

## Implementation Plan — RE-VERIFIED against current main (2026-07-03, sendev-promise-exec)

> **Provenance.** The measured plan below was first banked by the prior
> claimant (ttraenkler/opus-dev, docs-only, never merged — its fork branch
> `issue-2959-native-promise-executor` had zero code, only two docs commits).
> I (senior-dev, sendev-promise-exec) independently re-anchored every cited
> symbol against **current `origin/main` (0f4ad3231)**, resolved the plan's one
> open VERIFY item, and re-sized. **The substrate is confirmed ready and the
> plan is accurate.** See the sizing verdict at the end for why this is banked,
> not built, in this budget window.

### Anchors re-confirmed on current main (0f4ad3231)

| Symbol | Location (current main) | Role |
| --- | --- | --- |
| `new Promise(executor)` host-import site | `src/codegen/expressions/new-super.ts:2759-2778` | The block to wrap with the native branch. Currently ALWAYS `call Promise_new`. |
| `isStandalonePromiseActive(ctx)` | `src/codegen/async-scheduler.ts:3297` | The gate (`ctx.wasi === true` today). |
| `emitStandalonePromiseResolve` / `emitStandalonePromiseReject` | `async-scheduler.ts:3109` / `:3124` | Reference for the `$Promise` struct shape — put the new helper alongside. |
| `getOrRegisterPromiseType` | `async-scheduler.ts:258` | `$Promise` type. **3 fields**: `[state (i32), value (externref), callbacks (externref)]`. |
| `ensurePromiseSettleFunctions` | `async-scheduler.ts:750` | Mints & pushes all settle funcs; sets the funcIdx slots below. |
| `state.promiseResolveValueFuncIdx` | set at `async-scheduler.ts:772/816-823` | The **assimilating** resolve target (routes through fulfill; adopts a promise value). USE THIS for `resolve`. |
| `state.promiseRejectFuncIdx` | set at `async-scheduler.ts:766/783-790` | The reject target. USE THIS for `reject` and the executor-throw catch. |
| `getOrCreateFuncRefWrapperTypes` + `ctx.funcRefWrapperCache` | `src/codegen/closures.ts:3312-3353` | Per-signature canonical `__fn_wrap` struct + lifted func type. Key = paramKinds→resultKinds. |
| callback-arg closureInfo resolution pattern | `src/codegen/expressions/calls.ts:3455-3492` (`compileStandalonePromiseThenCallback`) | The EXACT pattern to obtain the executor's `ClosureInfo` + compiled instrs, with a clean **null-return fallback** for non-resolvable args. |
| `call_ref` a resolved closure | `calls.ts:1084-1133` | The invoke shape: `ref.cast structTypeIdx` → args → `struct.get fieldIdx 0` (func field) → `emitGuardedFuncRefCast(funcTypeIdx)` → `call_ref funcTypeIdx`. |

### VERIFY item — RESOLVED ✓ (double-settle guard)

The plan flagged: "both [settle closures] must be no-ops after the first
settle — verify the guard exists." **Confirmed present.**
`buildPromiseSettleBody` (`async-scheduler.ts:834`, used by BOTH
`__promise_fulfill` and `__promise_reject`) opens with, at lines 847-859:

```
local.get $promise; struct.get $Promise 0 (state)
i32.const PROMISE_STATE_PENDING; i32.ne
if (empty) { local.get $value; return }      ; already-settled ⇒ return value, state intact
```

`__promise_resolve_value` (assimilation) routes through fulfill and so
inherits the guard. So **double-settle / settle-after-throw is a spec-correct
no-op by construction** — the native executor path does NOT need its own
guard. This was the single largest correctness risk and it is retired.

### Exact site

`compileNewExpression` in `src/codegen/expressions/new-super.ts:2759`
(the `expr.expression.text === "Promise"` block). Wrap the native path in
front of the existing host path:

```ts
if (
  isStandalonePromiseActive(ctx) &&
  (expr.arguments?.length ?? 0) >= 1 &&
  !isPromiseUserShadowed(ctx, expr)         // mirror resolvesToAmbientGlobal guard
) {
  const ok = emitStandalonePromiseFromExecutor(ctx, fctx, expr.arguments![0]!);
  if (ok) return { kind: "externref" };
  // ok === false ⇒ non-resolvable executor; FALL THROUGH to the host path.
}
// existing Promise_new host path (byte-inert in host mode — gate is wasi-only)
```

Gate strictly on `isStandalonePromiseActive(ctx)` (= `ctx.wasi === true`
today) so host mode is byte-unchanged and the standalone/wasi widen stays
coupled to #2867 slice-1d (do NOT pre-widen — the −601 lesson).

### New helper: `emitStandalonePromiseFromExecutor(ctx, fctx, executorArg): boolean`

Put it in `src/codegen/async-scheduler.ts` next to
`emitStandalonePromiseResolve`. Returns `false` (emitting nothing) when the
executor is non-resolvable, so the caller falls back to the host path.
Reuses existing infra: `getOrRegisterPromiseType`,
`ensurePromiseSettleFunctions` (gives `promiseResolveValueFuncIdx` /
`promiseRejectFuncIdx`), `getOrCreateFuncRefWrapperTypes`, `ensureExnTag`.

Steps:

1. **Resolve the executor closure FIRST** (before emitting anything), using
   the `compileStandalonePromiseThenCallback` pattern (calls.ts:3455): compile
   `executorArg` via `compileArrowAsClosure` (arrow/func-expr) or
   `compileExpression` (identifier→`ctx.closureMap`) into a scratch buffer and
   look up its `ClosureInfo` (`ctx.closureInfoByTypeIdx.get(type.typeIdx)` with
   the `ctx.closureMap.get(arg.text)` fallback). **If no ClosureInfo ⇒ return
   `false`** (host fallback). Do NOT emit a broken native path. (Start: inline
   arrow + named func-expr; widen later.)

2. **`ensurePromiseSettleFunctions(ctx)`**, then **mint the two settle-wrapper
   funcIdxs UP-FRONT and cache them on scheduler state** (call them
   `__promise_resolve_cl` / `__promise_reject_cl`). ⚠️ **FUNCIDX-SHIFT
   DISCIPLINE — the #1 hazard here (see the sizing verdict).** Mint via
   `mintDefinedFunc` and `pushDefinedFunc` BEFORE any code references them,
   exactly as `ensurePromiseSettleFunctions` mints all its slots before pushing
   bodies (async-scheduler.ts:765-772). Cache on `AsyncSchedulerState` so
   they're emitted once per module, not per `new Promise`.
   - Signature = canonical `(ref $wrapCap, externref value) -> ()` where
     `$wrapCap` is a struct **subtype** of the `(externref)->()` canonical
     `__fn_wrap` root
     (`getOrCreateFuncRefWrapperTypes(ctx, [{kind:"externref"}], [])`) with one
     extra immutable field `cap0: (ref $Promise)`.
   - Body: `local.get 0; ref.cast $wrapCap; struct.get $wrapCap cap0` (captured
     promise) → `local.get 1` (value) → `call promiseResolveValueFuncIdx`
     (resolve) / `promiseRejectFuncIdx` (reject) → `drop` (the settle helpers
     return the value). resolve MUST route through `promiseResolveValueFuncIdx`
     (assimilation), NOT `promiseFulfillFuncIdx`, so `resolve(anotherPromise)`
     chains.

3. **Allocate the pending `$Promise`** into a local `p (ref $Promise)`:
   `i32.const PROMISE_STATE_PENDING; ref.null.extern (value); ref.null.extern
   (callbacks); struct.new $Promise; local.set p`. (3 fields — confirmed.)

4. **Materialize resolve/reject as closure VALUES** (externref) in locals
   `rv`, `rj`: for each, `ref.func $..._cl; local.get p; struct.new $wrapCap;
   extern.convert_any`.

5. **Invoke the executor synchronously, wrapped in try/catch on
   `ensureExnTag`:**
   - Replay the executor's compiled closure instrs to get its closure ref, then
     invoke via the calls.ts:1084-1133 shape: push `rv` (and `rj` only if
     executor arity ≥ 2 — see edge cases), coerce each to the executor's
     declared param type via the normal arg-coercion path, then
     `struct.get execStruct 0` (func) → `emitGuardedFuncRefCast(execFuncTypeIdx)`
     → `call_ref execFuncTypeIdx`. If the executor has a non-void return, `drop`
     it.
   - `catch exnTag`: `local.set $reason; local.get p; local.get $reason; call
     promiseRejectFuncIdx; drop`. Executor-throw-before-settle ⇒ reject; the
     settle guard makes it a spec-correct no-op if the executor already settled.

6. **Return the promise**: `local.get p; extern.convert_any` → externref, and
   return `true`.

### Edge cases / correctness

- **Non-arrow / non-resolvable executor** (variable or call result with no
  recoverable `ClosureInfo`): return `false` at step 1 ⇒ host fallback. Never
  emit a partial native path.
- **Executor arity 0/1** (`new Promise(() => {})`, `new Promise(res => …)`):
  pass only as many of `rv`/`rj` as the executor's `paramTypes.length` (pass
  `rv`, then `rj` only if arity ≥ 2). The lifted func has a fixed arity; over-
  or under-supplying args is a validation error.
- **`Promise` user-shadowed**: guard with a `resolvesToAmbientGlobal`-style
  check (mirror the `GLOBAL_NON_CONSTRUCTOR_FUNCTIONS` guard already in
  new-super.ts:2746-2755) so a user `class Promise {}` keeps the normal ctor
  path.
- **Late-import interaction (#2918)**: the executor body compiles into a live
  buffer that the late-import shifter walks. Any late import minted AFTER the
  new wrapper funcs shifts funcIdxs — the up-front-mint discipline in step 2
  plus `flushLateImportShifts` at the site must keep `rv`/`rj`/executor
  `call_ref` targets correct. This is the sibling hazard #2918 is literally
  about — test with a program that forces a late import (e.g. an object literal
  or `.then` chain) around the `new Promise`.

### Tests (`tests/issue-2959.test.ts`, compile with `--target wasi`)

resolve-sync, reject, executor-throw-before-settle, double-settle-ignored,
resolve-with-thenable (chains), resolve-async-via-then. **Leak-elim proof**:
walk the emitted binary's import section and assert ZERO
`env::`/`Promise_new` imports — this is the load-bearing acceptance check.
Add a **sha256 byte-diff** of a host-mode `new Promise` compile vs main to
prove host-mode byte-inertness (guaranteed by the wasi-only gate, but assert
it). NOTE: `tests/issue-*.test.ts` are NOT in required CI (#3008) — the
behavioral proof must ALSO show up as host-free-floor movement in the
standalone gate, or add an equivalence-suite case.

### Size / routing note

Measured as an **L** (two synthesized capturing closure trampolines + the
canonical-wrapper-subtype ABI + a synchronous executor `call_ref` from inside
a compiled executor body + throw→reject try/catch + the funcidx-shift
discipline + 6 behavioral tests and two structural assertions). Above the
originally-tagged M; frontmatter bumped `horizon: l`.

## Sizing verdict & handoff (sendev-promise-exec, 2026-07-03)

**Banked, not built — deliberate senior-dev call.** The plan is de-risked and
buildable in one pass by a **fresh-budget-window** dev; it is NOT a safe
deliverable in the current draining window (~19% budget, <1 day) for three
reasons:

1. **Silent-miscompile failure mode.** The risk here is not "runs out of time
   with a clean partial" — it's minting a wrong funcidx or an incorrect
   closure-subtype cast that silently miscompiles **every** executor-pattern
   Promise. Validating against that needs the full
   build→wasm-validate→behavioral→leak-scan→CI→merge_group loop. The open
   sibling **#2918** ("native-promise-then funcidx-shift") is live proof this
   hazard class bites this exact subsystem.
2. **Active file contention (2026-07-03).** `async-scheduler.ts` had
   uncommitted edits in the `issue-2867-standalone-promise-carrier` worktree
   and `new-super.ts` in `issue-2162-set-clean` — the two files this touches.
   No open PRs yet (so no hard block), but landing a large helper into
   `async-scheduler.ts` mid-flight invites conflict churn.
3. **The substrate is fully ready**, so no verification value is lost by
   deferring — every anchor is confirmed and the one VERIFY item is resolved.
   A fresh-budget dev picks this up and implements straight down the plan.

**Recommended dispatch:** senior-developer, fresh budget window, `horizon: l`.
This spec PR carries only the enrichment; the fork code branch
`issue-2959-native-promise-executor` has no salvageable code and can be
recreated from `origin/main`.

## Implementation (done, 2026-07-03, sendev-promise-exec2)

Shipped as `src/codegen/promise-executor.ts` (new module) +
`emitStandalonePromiseFromExecutor` wired into the `new Promise` block of
`src/codegen/expressions/new-super.ts`, gated on `isStandalonePromiseActive`.

### Key ABI discovery (why the banked "subtype the wrapper" plan is correct — and *why* it works)

I re-verified the executor's resolve/reject dispatch against **true WASI mode**
before implementing (the banked plan reasoned about it but hadn't traced the
lowering). Findings that shaped the code:

1. **The executor's `resolve`/`reject` params are BOTH `externref`.** A
   Promise-executor `resolve` is always `(value: T | PromiseLike<T>) => void`
   and `reject` is `(reason?: any) => void`; both value params resolve to
   `externref` for *every* `T`. So the canonical `(externref) -> ()` func-ref
   wrapper is the universal signature — no per-`T` variance. This is why the
   settle closures can be a single `$__promise_settle_cap` subtype of that one
   wrapper.

2. **In WASI mode the executor's `resolve(x)` call has NO host fallback.** The
   host `__call_function` reflective arm is gated `!ctx.standalone && !ctx.wasi`
   (calls.ts). Under WASI, `resolve(x)` lowers to: `any.convert_extern;
   ref.test (ref $wrap)` → **native** `struct.get 0 -> ref.cast $wrapFuncType ->
   call_ref`, **else throw TypeError**. So a `resolve`/`reject` value that IS a
   subtype of the canonical `(externref)->()` wrapper dispatches natively; the
   only remaining host import in the whole executor program was `Promise_new`
   itself. Constructing the settle closures as that subtype removes it → **zero
   `env` imports** (verified: gc sha256 byte-identical, wasi env `[]`).

3. **The `sub final` on the wrapper is a non-issue.** `markLeafStructsFinal`
   marks a struct `final` only when *nothing* subtypes it — and it is *skipped
   entirely* for standalone/WASI (`skipFinal`). Adding `$__promise_settle_cap`
   as a subtype also un-finalises the wrapper in gc mode. So the capturing
   subtype is legal.

4. **The trampoline func type must be EXACTLY the wrapper's lifted type**
   (`getOrCreateFuncRefWrapperTypes(...).liftedFuncTypeIdx`), so the executor's
   `ref.cast (ref $wrapFuncType); call_ref` at the call site succeeds. The
   trampoline body downcasts its `(ref null $wrap)` self param to the `cap`
   subtype to recover the captured `$Promise` — the same self-param-downcast
   trick the existing capturing-closure and `.then`-wrapper machinery use.

### Correctness proofs (all host-free, env imports `[]`)

- resolve-sync → `.then` sees `7`; reject → `.catch` sees `9`;
  **executor-throw → `.catch` sees `42`** (inject-throw execution proof: a
  vacuous native path would leave the observer at `-1`); double-settle →
  first-settle-wins (`3`); resolve-with-a-promise → assimilates inner value
  (`11`). All GC binaries `WebAssembly.validate` + instantiate + run `_start`
  without trapping. Host (gc) mode sha256 byte-identical to `main`.

### Scope / conservatism

- Native path is narrow-gated to **inline arrow / (non-async, non-generator)
  function-expression** executors whose `ClosureInfo` is recoverable. Anything
  else (identifier-bound, non-resolvable) emits **nothing** and falls through to
  the existing `Promise_new` host path — never a partial native path. Widening
  to identifier-bound closures is a future increment.
- `Promise_new` intentionally **left on the strict-gate allowlist**: removing it
  would turn the host-fallback edge cases into hard compile errors under WASI (a
  regression). The native path simply stops emitting it for the common case.
- Gate stays WASI-only (couples to #2867 slice-1d; the −601 lesson — do not
  pre-widen to all-standalone).
