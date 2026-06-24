---
id: 2637
title: "Promise capability executor-body protocol: __promise_subclass_ctor ↔ <Sub>_new ↔ NewPromiseCapability re-architecture"
status: ready
created: 2026-06-24
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, promise, async, capability-bridge, class
language_feature: promise, async, class
goal: async-model
sprint: 66
parent: 2623
related: [2623, 2614, 1528, 1042, 86, 56]
note: "Spun off from #2623 as the architecture epic for the executor-body half. The #2623 landable substrate (box-depth #1981, identity #1977) is banked; this is the deep tail that both #2623-A and #2623-B re-groundings, plus the #1996 verify-first probe, characterized as NOT a bounded dev slice. Deep-tracing-dev-wrote-the-plan (sendev-2623a), NOT a speculative implementation."
---
# #2637 — Promise capability executor-body protocol re-architecture

## Why this exists

`Promise.all/race/any/allSettled/withResolvers/try` invoked on a user
`class SubPromise extends Promise` (the test262 `ctx-ctor.js` rows) must run the
**user's constructor body** when V8's `NewPromiseCapability(SubPromise)` performs
`Construct(SubPromise, «executor»)`. Today it does not, so the rows fail at
`assert #3` (`callCount === 1`) / `#4` (`typeof executor === 'function'`).

This is the **executor-body half** of #2623. The capability cluster's bounded
substrate already landed:
- **#1981** — box-depth lowering (single-box nested capture; killed the
  `illegal cast in Constructor()` trap). MERGED.
- **#1977** — `class extends Promise` value-read / receiver IDENTITY unification
  (`instance.constructor === SubPromise`, asserts #1/#2). MERGED.

What remains is the deep, coupled executor-body protocol. Both #2623-A and
#2623-B re-groundings flagged it NOT-bounded; the #1996 verify-first probe
(2026-06-24) confirmed it with WAT/runtime evidence. This issue is the architect
re-spec so it can be picked up deliberately, B1 → B2.

## Acceptance criteria

- `built-ins/Promise/{all,race,any,allSettled,withResolvers,try}/ctx-ctor.js`
  reach `callCount === 1` and `typeof executor === 'function'` (asserts #3/#4),
  with identity (#1/#2) still green.
- Direct `new SubPromise(executor)` runs the user body and does not throw
  `Promise resolver ... is not a function`.
- No regression on the already-green `extends Promise` corpus
  (`finally/subclass-*`, the #1977 `withResolvers/ctx-ctor` row, plain-class /
  Error-subclass / local-shadow identity).
- Broad-impact → **merge_group floor authoritative** (#2097) per
  `project_broad_impact_validate_full_ci`; the standalone floor must stay green
  (the synthesized subclass is JS-host-only — standalone short-circuits to the
  fallback, must not LinkError, cf. #1941).

---

## Re-grounding evidence (current main, post-#1977/#1981 — sendev-2623a, 2026-06-24)

Faithful per-process runner (`runTest262File`, one `npx tsx` process per file —
NOT an in-process loop, which falsely reports `compile_error`) + WAT decode.

### Where the user body lives, and why it never runs
The user constructor body **IS fully compiled** as
`$SubPromise_new(externref) → externref`. Decoded body for
`class SubPromise extends Promise { constructor(a){ super(a); executor=a; callCount+=1; } }`:
```wat
(func $SubPromise_new (param externref) (result externref)   ;; param 0 = executor `a`
  (local $__self externref)
  ...
  local.get 0
  call $__new_Promise_import          ;; super(a) — builds a host Promise from the executor
  ...
  local.get 0
  global.set $executor                ;; executor = a
  global.get $callCount  f64.const 1  f64.add  global.set $callCount   ;; callCount += 1
  local.get 1
  global.get $SubPromise.prototype  ref.null extern  call $__set_subclass_proto_import
  local.get 1)                        ;; return self
```
So the body is correct and present. The gap is purely **invocation**: V8's
`NewPromiseCapability(C)` does `new C(internalExecutor)` where
`C = __promise_subclass_ctor(name)` is a **BARE** `class extends Promise {}`
(`src/runtime.ts:10369-10387`, line 10378:
`C = class extends (Promise as ...) {};`) whose DEFAULT constructor only forwards
`super(executor)` and **never calls `$SubPromise_new`**. The combinators
(`Promise.all.call(C, …)` → `runtime.ts:10389+`) route through this bare host `C`,
so `executor` / `callCount` are never touched.

### Two coupled blockers (each independently verified)

**B1 — executor marshalling at the `super(<builtin Promise>)` boundary.**
Pre-existing and INDEPENDENT of the combinators. Probe (direct new, JS-host):
```ts
new SubPromise((res, rej) => { res(1); })   // => "Promise resolver [object Object] is not a function"
```
`$SubPromise_new` forwards the executor `a` to the real `Promise` constructor via
the extern-class construction path (`__new_Promise(executor)`), but `a` arrives
**boxed/wrapped** (not a raw callable), so V8's `Promise` ctor rejects it. The
executor must be unwrapped (`_maybeWrapCallable`-style, the host already has the
machinery) at the `super(builtin)` boundary BEFORE it reaches `__new_Promise`.
- **Broad-impact**: touches the extern-class `super(builtin)` construction path
  (every `class extends <builtin>` with a constructor that forwards an arg).
- **0 test262-row payoff ALONE**: every ctx-ctor row goes through the
  combinator / NewPromiseCapability path, not direct-new. So B1 is NOT a
  standalone landable slice — it is a prerequisite for B2, validated together.

**B2 — wasm→host constructor-callback registration + run-on-host-`this`.**
To run the user body under `NewPromiseCapability(C)`, three interdependent pieces:
1. **Register `$SubPromise_new` as a host-callable closure keyed by class name.**
   The host CAN already call wasm closures (`exports.__call_fn_N` via
   `setExports`, `runtime.ts:1876+`), but there is no mechanism to register a
   class constructor under its name for `__promise_subclass_ctor` to look up. Add
   a registration import (e.g. `__register_promise_subclass_ctor(name, closure)`)
   emitted once per `class extends Promise` with a user constructor, materializing
   `$SubPromise_new` as a closure (couples to **#2623-A** — the executor it
   receives is a capturing closure marshalled inbound; box-depth #1981 is the
   prerequisite there).
2. **Make `__promise_subclass_ctor` build a `C` whose constructor invokes the
   registered closure** with V8's internal executor, instead of the bare default
   ctor. Roughly:
   ```js
   C = class extends Promise {
     constructor(exec) { super(exec); _subclassBodies.get(name)?.(/*this,*/ exec); }
   };
   ```
3. **Re-architect `$SubPromise_new` to run as a ctor body ON a host-provided
   `this`** (the capability promise V8 created via `super(exec)` in step 2),
   instead of allocating its OWN promise via `__new_Promise`. Today
   `$SubPromise_new` builds and returns a fresh promise; under NewPromiseCapability
   the promise is V8's, so the body must bind `this` to it and only run the
   side effects (`executor = a; callCount += 1`) + proto wiring. This change ALSO
   affects the direct-new path (step must not regress `new SubPromise(...)`).

### Why this is genuinely multi-PR (not a bounded slice)
- B2.1/B2.2 depend on B1 (the executor must be a callable before a registered
  closure can use it).
- B2.3 changes the direct-new path too (the `$SubPromise_new` "own-promise vs
  host-this" split), so it cannot be validated in isolation from B1.
- None of B1, B2.1, B2.2, B2.3 is independently floor-positive: B1 alone = 0
  rows; B2 without B1 = the executor is still non-callable.
- Therefore: a single bounded dev slice does not exist. This is an ABI +
  protocol re-architecture.

---

## Implementation Plan (architect spec — B1 → B2 sequencing)

### Phase B1 — executor unwrap at `super(<builtin Promise>)` (prerequisite)
- **Locus**: the extern-class `super(builtin)` construction lowering (the path
  that emits `__new_Promise(executor)` inside `$<Sub>_new`). Find it via the
  `classBuiltinParentMap` consumers in `src/codegen/class-bodies.ts`
  (≈ lines 762, 1634, 1807, 2454) and the `new-super.ts` builtin-parent branch.
- **Change**: when the builtin parent is `Promise` (executor-taking ctor),
  unwrap the constructor arg to a raw host callable before it flows to
  `__new_Promise`. Mirror the host `_maybeWrapCallable(executor, 2, callbackState)`
  already used by `Promise_new` (`runtime.ts:10437`) — i.e. ensure the wasm side
  hands `__new_Promise` a value the host will unwrap, OR add the unwrap in the
  `__new_Promise` host shim. Prefer the host shim (`__new_Promise` should
  `_maybeWrapCallable` its arg) — pure-runtime, no funcidx shift.
- **Validation**: direct `new SubPromise(executor)` runs the body (callCount=1,
  no "resolver is not a function"). Add `tests/issue-2637-*.test.ts` for the
  direct-new path. **No test262 row flips yet** — gate B1 on the unit test +
  no-regression sweep only.
- **Edge cases**: (a) executor already a raw function → passthrough. (b)
  non-Promise builtin parent (`extends Array/Map/...`) → unchanged. (c)
  standalone → the synthesized-subclass path is JS-host-only; standalone keeps
  its existing fallback (no LinkError, #1941).

### Phase B2 — ctor-closure registration + run-on-host-`this`
- **B2.1 (codegen + new import)**: for each `class extends Promise` with a user
  constructor, emit a one-time `__register_promise_subclass_ctor(name, closure)`
  where `closure` materializes `$SubPromise_new` (use the established closure
  materialization; the executor arg it later receives is a capturing closure —
  **box-depth #1981 is the prerequisite**). Watch late-import funcidx shifts
  (`flushLateImportShifts`, cf. the #1977 `emitPromiseSubclassCtor` pattern and
  `project_standalone_hostimport_gate_index_shift`).
- **B2.2 (runtime)**: `__promise_subclass_ctor` (`runtime.ts:10369`) builds `C`
  whose constructor calls the registered closure after `super(exec)`. Thread
  `callbackState` so the closure dispatch (`__call_fn_N`) is available.
- **B2.3 (codegen)**: split `$SubPromise_new` into "allocate-own-promise" (direct
  new, legacy) vs "run-on-host-`this`" (NewPromiseCapability). Under the latter,
  bind `this`/`$__self` to the host-provided promise and run only the side
  effects + proto wiring; do NOT call `__new_Promise` again. Must not regress the
  direct-new path validated in B1.
- **Validation**: the 6 ctx-ctor rows reach asserts #3/#4; the #1977
  `withResolvers/ctx-ctor` row + `finally/subclass-*` stay green;
  **merge_group floor mandatory** (broad: every `__promise_subclass_ctor`
  consumer incl. the combinators, plus the extern-class super path).

### Sequencing
```
B1 (executor unwrap at super(builtin Promise))  ──► prerequisite, 0 rows alone
   └─► B2 (ctor-closure registration + run-on-host-this)  ──► flips the 6 ctx-ctor #3/#4
        depends on: B1, AND #2623-A box-depth (#1981, landed — executor is a capturing closure)
```

### Out of scope (do NOT bundle)
- The general host-facing returned-instance prototype-dispatch gap (#2628 host
  residual) — separate acorn-host lane, ~0 test262 payoff (per #2623-B
  re-grounding).
- `invoke-resolve` observable-resolve element-identity (#2623-D) — follow-up.

## Downstream consumers unblocked
- `Promise.try/{promise,ctx-ctor,not-a-constructor}` (capability-ctor identity
  THROUGH the bridge — #2623 "Downstream consumers" §, `Promise.try` rows).
- `.finally/species-constructor` + `this-value-thenable` (read
  `this.constructor[@@species]` through the capability — same identity+body
  substrate).
- The #2614 combinator headline coupling (the executor body running is the
  precondition for the observable-resolve composition in #2623-D).
