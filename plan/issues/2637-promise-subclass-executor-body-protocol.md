---
id: 2637
title: "Promise capability executor-body protocol: __promise_subclass_ctor ↔ <Sub>_new ↔ NewPromiseCapability re-architecture"
status: done
assignee: sdev-b2codegen
created: 2026-06-24
completed: 2026-06-25
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

### Phase B1 — executor unwrap at `super(<builtin Promise>)` — ✅ LANDED (sdev-definebuiltin, 2026-06-24)

**Implemented** the spec's PREFERRED pure-runtime approach (host-shim unwrap, no
funcidx shift, no codegen change). The locus is the generic extern-class `new`
host handler in `src/runtime.ts` (the `intent.action === "new"` arm, the closure
`return (...args) => { … new Ctor(...args) }` that backs `__new_Promise` /
`__new_<Builtin>`). It returns `new Ctor(...args)` with the executor forwarded
verbatim; for `intent.className === "Promise"` the first arg now passes through
`_maybeWrapCallable(args[0], 2, callbackState)` first — exactly the unwrap the
`Promise_new` shim already applies (`new Promise(_maybeWrapCallable(executor, 2,
callbackState))`).

- **Repro confirmed on clean main first**: the B1 unit test fails on unfixed
  runtime (throws at the `new Ctor(...args)` line — "Promise resolver
  [object Object] is not a function"), passes with the unwrap. So the fix is
  load-bearing, not vacuous.
- **Behavior-neutral elsewhere**: `_maybeWrapCallable` is a no-op for raw
  functions (edge case a) and for null/undefined; the unwrap is gated on the
  `Promise` parent only (edge case b — `extends Array` etc. unchanged); the
  host-only `new` handler never runs under standalone (edge case c, #1941).
- **Tests**: `tests/issue-2637-b1-executor-unwrap.test.ts` (4 cases: direct
  `new SubPromise(executor)` runs the body + callCount=1; executor actually
  invoked; `extends Array` regression; plain `new Promise(fn)` regression).
- **No-regression sweep** (#2623 identity / #1366a/b / #1977 / #1981 /
  #28-promise-executor / promise-combinators): all green EXCEPT 2 PRE-EXISTING
  failures in `promise-combinators.test.ts` (`Promise.race`/`Promise.allSettled`
  "undefined is not iterable" at `runtime.ts:10444`) — verified identical on
  clean origin/main, unrelated to B1.
- **0 test262 rows flip on B1 alone** (as the spec predicted — the ctx-ctor rows
  go through the combinator / NewPromiseCapability path, addressed by B2). B1 is
  the prerequisite for B2; the issue stays OPEN for B2.

Original spec direction (retained for B2 reference):

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

## B2 design grounding (sdev-definebuiltin, 2026-06-24 — code surface confirmed)

Read the actual B2 surface against current main. The spec's "ABI + protocol
re-architecture, genuinely multi-PR" framing is **confirmed accurate** — B2 is a
deep three-way coupled change, validatable only via the merge_group test262 floor
(the 6 ctx-ctor rows). Concretely:

- **B2.1 closure materialization is the hard unknown.** A class constructor is
  emitted as a top-level function `$<Class>_new` (`class-bodies.ts:779`,
  `ctorName = `${className}_new``), NOT a closure struct. The host can only invoke
  a wasm function via the closure-dispatch path (`__call_fn_N(closure, ...args)`,
  `runtime.ts:1834`/`1880`), which requires an actual closure STRUCT recognized by
  `__is_closure`. So B2.1 must materialize `$<Class>_new`'s funcref into a
  no-capture closure struct and register it under the class name via a NEW host
  import `__register_promise_subclass_ctor(name, closure)` — emitted once per
  `class extends Promise` with a user ctor. This couples to the closure
  representation in `closures.ts` and to late-import funcidx-shift discipline
  (`flushLateImportShifts`, cf. `emitPromiseSubclassCtor` + the
  `project_standalone_hostimport_gate_index_shift` hazard).
- **B2.2 (runtime)** reworks `__promise_subclass_ctor` (`runtime.ts:~10397`) so
  the synthesized `C`'s constructor calls the registered closure (threading
  `callbackState` for `__call_fn_N`) after `super(exec)` — instead of the current
  bare `class extends Promise {}`.
- **B2.3 (codegen) is the deepest.** The ctor body maps `this → $__self`
  (`class-bodies.ts:1553`), and `$__self` is produced by the `super()` →
  `__new_Promise` path (the one B1 just fixed). B2.3 must SPLIT the ctor into
  "allocate-own-promise" (direct-new, legacy — the B1 path) vs "run-on-host-`this`"
  (NewPromiseCapability — bind `$__self` to V8's capability promise, run only the
  side effects + proto wiring, do NOT call `__new_Promise` again). This changes
  the ctor's allocation contract and MUST NOT regress the B1 direct-new path.

**Why none of this is a quick slice**: B2.1/B2.2/B2.3 are mutually dependent
(closure must exist before the runtime can call it; the run-on-host-`this` split
can't be validated without the registration+dispatch wired through), and the only
positive signal is the merge_group test262 floor — there is no isolated unit-test
green for B2 short of the whole protocol. This is `reasoning_effort: max` work
that warrants a fresh, dedicated session (B1's prerequisite must also LAND first
before B2 can enqueue). B1 (PR #2019) is queued; B2 should be picked up as its own
focused session once B1 merges.

## B2 IMPLEMENTATION STATE — runtime half DONE, codegen half REMAINING (sdev-definebuiltin, 2026-06-24)

Branch: `issue-2637-b2-ctor-closure-registration` (stacked on B1). Held #2637 claim.

### ✅ Runtime half LANDED on the branch (B2.2 + the registration import) — typechecks clean (tsc exit 0)

In `src/runtime.ts`:
1. **`InstanceState` gained two per-instance registries** (next to the #1933
   `subclassCtors`/`userClassParents`): `promiseSubclassBodies?: Map<string,
   Function>` and `promiseSubclassCtors?: Map<string, any>`. Per-instance (NOT
   module-scope) to avoid cross-module retention, matching the #1933 pattern.
   The old `__promise_subclass_ctor` cached its ctor map in a closure-local
   `const _promiseSubclassCtors` — that worked because the handler ran once, but
   the registry now must be SHARED between two separate import handlers
   (`__register_*` and `__promise_subclass_ctor` are resolved by separate
   `resolveImport` calls), so it moved to `instanceState`.
2. **New host import `__register_promise_subclass_ctor(nameRef, ctorClosure)`**:
   `String()`s the name, `_maybeWrapCallable(ctorClosure, 1, callbackState)` to
   bridge the wasm closure to a host callable (arity 1 = the executor), stores it
   in `instanceState.promiseSubclassBodies`. No-ops if `instanceState` absent or
   the value isn't callable.
3. **`__promise_subclass_ctor` reworked**: the synthesized `class extends Promise`
   now has `constructor(exec){ super(exec); body?.call(this, exec); }` that, when
   a body was registered for the class name, runs it ON `this` (V8's capability
   promise). `body.call(this, exec)` reaches `__call_fn_method_1` so the wasm body
   observes `this` as `__current_this`. Default-ctor subclasses (no registered
   body, e.g. #1977 `withResolvers/ctx-ctor` identity row) keep the bare forwarder
   — unchanged. Throwing bodies propagate verbatim.

### ⚠️ Codegen half REMAINING — B2.1 + B2.3 (the deep part; NOT yet started)

**B2.1 — emit the registration + materialize `$<Class>_new` as a closure.**
- For each `class extends Promise` WITH a user constructor, emit a one-time
  `__register_promise_subclass_ctor(<className string>, <ctor closure>)`. Use
  `ensureLateImport` + `flushLateImportShifts` exactly like
  `emitPromiseSubclassCtor` in `src/codegen/expressions/promise-subclass.ts`
  (mind `project_standalone_hostimport_gate_index_shift`). Gate on
  `!isStandalonePromiseActive(ctx)` (host-only; standalone keeps #1941 fallback).
- The hard sub-problem: `$<Class>_new` is a TOP-LEVEL function (`ctorName =
  `${className}_new``, `class-bodies.ts:779`), NOT a closure struct. To pass it to
  the host as something `__call_fn_1` can dispatch, materialize a NO-CAPTURE
  closure struct whose field 0 = `ref.func`. The closure struct shape is in
  `closures.ts` (field 0 funcref, subtype of the shared wrapper via
  `getOrCreateFuncRefWrapperTypes`; no-capture path at `closures.ts:1735`). A
  closure's lifted func takes `(ref $wrapperStruct, ...params)`. Safest: build a
  thin wrapper-closure body that calls `$<Class>_new__onhost` (B2.3), so existing
  direct-new callers of `$<Class>_new` are untouched. The funcref must be in the
  module's func table / declared elem so `ref.func` is legal (see how arrow
  closures declare their funcref in `closures.ts`).
- WHERE to emit: end of class-compilation in `class-bodies.ts` after
  `$<Class>_new` is in `ctx.funcMap`, guarded by "Promise-parent + has user
  ctor". `resolvePromiseSubclassName`/`classBuiltinParentMap` give the detection.

**B2.3 — split `$<Class>_new` into allocate-own (B1 direct-new) vs run-on-host-`this`.**
- THE CORRECTNESS TRAP (must solve before B2 is valid): the registered body is
  `$<Class>_new`, which today (B1 path) calls `__new_Promise(exec)` to ALLOCATE
  its own promise into `$__self` and returns it (`class-bodies.ts:2519-2586`
  builtin-parent `super()` branch + `selfLocal` plumbing at 1509/1553). If the
  runtime calls THAT body under `NewPromiseCapability` via `body.call(this,
  exec)`, it ALLOCATES A SECOND promise (double `__new_Promise`) and runs side
  effects on the wrong `$__self` — V8's capability promise (the real `this`) is
  never touched. So naively wiring B2.1→B2.2 is WRONG.
- The split: emit a SECOND function `$<Class>_new__onhost` (run-on-host-`this`):
  `$__self` is BOUND to the host-provided `this` (reachable as `__current_this`
  after `__call_fn_method_1`, runtime.ts:1844-1848) instead of allocating; the
  `super(exec)` → `__new_Promise` emission (class-bodies.ts:2519 branch) is
  SKIPPED (V8 already did `super(exec)` in the synthesized JS ctor); only the
  side effects + `emitSetSubclassProto`/`emitSetSubclassUserBrand` run; returns
  `this`. Register the closure over `$<Class>_new__onhost`; leave `$<Class>_new`
  (direct-new, B1) exactly as-is so the B1 direct-new path does not regress. This
  shape avoids any runtime mode-flag branch.

### Validation (B2, when codegen half lands)
- ONLY signal: the 6 `built-ins/Promise/{all,race,any,allSettled,withResolvers,
  try}/ctx-ctor.js` rows reach asserts #3 (callCount===1) / #4 (typeof executor
  === 'function') in the **merge_group test262 floor**. No isolated unit green.
- Keep #1977 `withResolvers/ctx-ctor` + `finally/subclass-*` + the B1
  `tests/issue-2637-b1-executor-unwrap.test.ts` direct-new cases green.
- Re-merge B1 if it changes; enqueue B2 ONE-SHOT only AFTER B1 lands; never re-enqueue.

### Resume steps for the next session
1. Re-claim with `--force` (claim held by sdev-definebuiltin): `node
   scripts/claim-issue.mjs 2637 ttraenkler/<agent> --branch
   issue-2637-b2-ctor-closure-registration --force`.
2. Enter worktree on branch `issue-2637-b2-ctor-closure-registration` (runtime
   half already committed + pushed). **B1 (PR #2019) HAS LANDED on main**
   (origin/main commit 3f73d6ab3, 2026-06-24) — so `git merge origin/main`
   first, then B2 is free to enqueue once its codegen half is green.
3. Implement B2.1 (closure materialization + registration emit) and B2.3
   (`$<Class>_new__onhost` run-on-host-`this` variant) per above.
4. Validate via merge_group (broad-impact, no scoped sweep). One-shot enqueue
   after B1 lands.

## ✅ B2 CODEGEN HALF — LANDED (sdev-b2codegen, 2026-06-25)

The codegen half (B2.1 + B2.3) is implemented and the full B2 protocol is
verified end-to-end in JS-host mode. All four ctx-ctor asserts pass for every
user-ctor combinator row.

### What was implemented

**B2.3 — `$<Class>_new__onhost` (run-on-host-`this`):**
- `emitPromiseSubclassOnHostCtor` (`src/codegen/class-bodies.ts`) fills a SECOND
  constructor body that mirrors the direct-new `$<Class>_new` shape but binds
  `$__self` to `__current_this` (the host capability promise installed by
  `__call_fn_method_1`) instead of allocating via `__new_Promise`.
- `compileSuperCall` gained an `onHost` parameter: in onHost mode it evaluates
  the `super(exec)` arguments for side effects only (no `__new_Promise`) and
  returns, leaving `$__self` untouched.
- The `$<Class>_new__onhost` func is PRE-REGISTERED in
  `collectClassDeclaration` (Phase 2), so its funcidx is stable for the closure
  materialization in Phase 3. Gated by `isPromiseSubclassWithUserCtor`
  (Promise-parent transitively + user ctor + JS-host; matches the
  `resolvePromiseSubclassName` / `isStandalonePromiseActive` gate exactly).

**THE CORRECTNESS TRAP — solved, and a SECOND one found + fixed:**
1. Documented double-`__new_Promise`: solved by the onHost-mode super skip (no
   second allocation; `$__self` = host `this`).
2. **NEW (identity break)**: the onHost body must ALSO NOT call
   `emitSetSubclassProto` / `emitSetSubclassUserBrand` / `__tag_user_class`. V8
   constructs `this` via `new C(exec)` where `C` is the
   `__promise_subclass_ctor` synthetic, so the instance's `[[Prototype]]` is
   already `C.prototype` — the SAME object the value-read `SubPromise` resolves
   to (#1977). `__set_subclass_proto` re-points to a DIFFERENT synthetic (the
   `subclassCtors`/#1933 registry), which broke `instance.constructor ===
   SubPromise` / `instanceof` (asserts #1/#2). Probe initially showed bits=12
   (cc1+fn4 only); after dropping the proto/brand/tag wiring in onHost mode →
   bits=15 (all four). The direct-new path STILL needs the proto fix (its
   instance comes from the bare `__new_Promise`), so that branch is untouched.

**B2.1 — registration emit:**
- `emitRegisterPromiseSubclassCtor` (`src/codegen/expressions/promise-subclass.ts`)
  emits `__register_promise_subclass_ctor(<name>, <closure>)` at the single
  chokepoint `emitPromiseSubclassCtor` (every combinator / value-read path),
  BEFORE `__promise_subclass_ctor(name)` — so whichever site executes first at
  runtime registers the body before `C` is synthesized/used. No module-init
  plumbing needed; runtime `Map.set` is idempotent.
- The closure is a no-capture closure over `$<Class>_new__onhost`, materialized
  via `emitFuncRefAsClosure` (creates a thin trampoline + the shared
  per-signature wrapper struct). `ensureLateImport` is flushed BEFORE the
  closure's `ref.func`/`struct.new` so the trampoline funcidx is not left stale
  by the import shift. The `(ref $struct)` closure is lifted to externref via
  `extern.convert_any` for the import arg. Default-ctor subclasses (no
  `__onhost` body) are a no-op here — the runtime's bare forwarder (the #1977
  `withResolvers/ctx-ctor` identity-only row) is unchanged.

### Verification (JS-host scoped — merge_group floor is the authoritative signal)
- `tests/issue-2637-b2-ctor-closure-registration.test.ts` (7 cases): the 5
  user-ctor combinator rows (`all/race/any/allSettled/try`) each reach
  bits=15 (asserts #1-#4 all pass); the default-ctor `withResolvers` identity
  row holds; direct-new still runs the body exactly once.
- No-regression sweep green: `#2637-b1`, `#1977`, `#2623-promise-subclass-identity`
  (incl. the `withResolvers/ctx-ctor` row + chained subclass), `#1366a/b`,
  `#28-promise-executor`, `#2158-class-identity`, `#2101a`, `#2174-async-closure`.
- `promise-combinators.test.ts`: 2 pre-existing failures only (the
  `Promise.race`/`allSettled` `undefined is not iterable` at the host shim,
  verified identical on origin/main — unrelated to this change).
- Stack-balance gate OK (no fixup-bucket increases); `tsc --noEmit` clean;
  prettier clean.
- The legacy `classes.test.ts`/`class-methods.test.ts` `string_constants`
  harness failures are PRE-EXISTING (confirmed identical on the pre-B2-codegen
  baseline a4ba60cad) — those suites instantiate with a bare `{ env: {} }` and
  predate the `buildImports`/`string_constants` design; not caused by B2.

### Files
- `src/codegen/class-bodies.ts` — `isPromiseSubclassWithUserCtor`,
  `$<Class>_new__onhost` pre-registration, `emitPromiseSubclassOnHostCtor`,
  `compileSuperCall(onHost)`.
- `src/codegen/expressions/promise-subclass.ts` — `emitRegisterPromiseSubclassCtor`
  + call from `emitPromiseSubclassCtor`.
- `tests/issue-2637-b2-ctor-closure-registration.test.ts` — B2 regression guard.
