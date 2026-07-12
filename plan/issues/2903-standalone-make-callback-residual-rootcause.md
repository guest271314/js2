---
id: 2903
title: "standalone: residual env.__make_callback leak is host-backed builtin methods (Promise.then/.catch, Iterator helpers), NOT a callback-representation gap"
status: ready
sprint: current
created: 2026-06-30
updated: 2026-07-11
priority: high
feasibility: hard
reasoning_effort: max
task_type: research+bugfix
area: codegen
language_feature: closures, promises, iterator-helpers
goal: host-independence
related: [2070, 2075, 399, 1326, 1326c, 2895, 2861, 2860, 2980]
origin: "2026-06-30 standalone __make_callback leak-front investigation (sendev-callback). Verified on main @ 1a53bd8d4, target standalone."
# (#3102/#3131) intended growth for the #2903 sub-front-1 de-leak: the module
# producer scan (declarations/types), the bridge miss-arm gate (calls.ts) and
# the Promise_new host-fallthrough flag (new-super.ts).
# (finally sub-front) the native §27.2.5.3 machinery lives with the then
# machinery in async-scheduler.ts; expressions.ts gains the per-node
# no-double-wrap marker check in isAsyncCallExpression. (NOTE: keep this
# list comment-free — parseFrontmatterList stops at the first non-item line.)
loc-budget-allow:
  - src/codegen/expressions/calls.ts
  - src/codegen/declarations.ts
  - src/codegen/context/types.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/async-scheduler.ts
  - src/codegen/expressions.ts
  - src/codegen/index.ts
  - src/codegen/iterator-native.ts
coercion-sites-allow:
  - src/codegen/iter-hof-native.ts
  - src/codegen/iter-lazy-native.ts
---

# #2903 — residual `env::__make_callback` leak: root cause + decomposition

## TL;DR (correct the framing first)

The leak-front task assumed the residual `env::__make_callback` leak is a
**callback-representation** problem — that ~1,092 standalone tests pass a
closure to a builtin method that is already lowered natively, and we just need
to route the closure through `call_ref`/funcref (extending the #2070/#2075 /
#399 native-callback path) instead of the `__make_callback` host bridge.

**That premise does not hold.** Measured on current main (`target: standalone`),
the residual `__make_callback` is a **real, referenced** host import (the binary
fails `WebAssembly.instantiate(binary, {})` with `Import #0 "env"`), and its
call sites are **host-backed builtin methods** whose *native* prototype bodies
are refusal stubs (`emitProtoMemberBodyRefusal` in
`src/codegen/array-object-proto.ts`). The callback **must** be host-callable
because the host implements the method — there is no native method body for a
`call_ref` closure to be handed to. So the fix is **implementing the native
method bodies** (invoking the predicate via `call_ref`), not switching the
callback representation.

## Why the earlier "dead import" read was wrong (trap to avoid)

A first pass classified the leak as a *dead* import (registered, never called)
by grepping the WAT for the symbolic call name `$__make_callback_import`. **The
WAT printer emits the import call as a numeric `call 0`, not the symbolic
name** — so the text grep found zero call sites and falsely concluded "dead."
Correct classifier: compute the import's function index from the import section
order, then match `call|return_call|ref.func <idx>` in the WAT, or simply test
`await WebAssembly.instantiate(binary, {})` and see it reject. The dead-import
prune that this false read motivated is the wrong fix — do not pursue it.

## Measurement (current main, `target: standalone`)

Stride sample of 452 test262 files across `built-ins` + `language`:

- **55 real leaks (12.2%)**; 303 clean / no import; 94 CE/unsupported.
- By callback-consuming method (detected from source):
  - `then` / `then+catch`: **29 (~53%)** — `Promise.prototype.then/.catch`
  - `(none-detected)`: 13 — async machinery / `new Promise(executor)` / default-param closures
  - `forEach`: 9 — **misattributed** (Array/Map/Set `forEach` are already native
    host-free; these are TypedArray.forEach or `.then` co-occurrence)
  - scattered: `every`, `sort`, `reduce`, `find` (Iterator helpers)

Cited examples reproduce the leak and fail host-free instantiation:
`built-ins/Iterator/prototype/find/predicate-returns-truthy.js`,
`language/expressions/async-function/named-dflt-params-ref-prior.js`,
`language/expressions/async-generator/named-dflt-params-ref-prior.js`.

Spot checks confirming what is **already native** (no leak): `[1,2,3].map/filter/
forEach` (typed), `Map.prototype.forEach`, `Set.prototype.forEach`. So #399 /
#2070 / #2075 did land the array-HOF native-callback path — that bucket is done.

## Root cause

`isHostCallbackArgument` (`src/codegen/closures.ts`) returns `true` for a closure
passed to any `HOST_CALLBACK_METHODS` name (`then`, `catch`, `finally`, `find`,
`every`, `some`, `reduce`, …) on a non-user receiver, routing it to
`compileArrowAsCallback` → `call __make_callback`. In standalone the receiving
method (Promise.then, Iterator.find, …) has **no native body** — the
`Iterator`/`Promise` proto glue (`makeGlue` in `array-object-proto.ts`) emits
`emitProtoMemberBodyRefusal`, i.e. a catchable-TypeError stub. So the only way
these "work" today is the host bridge, which is exactly the leak.

## Decomposition (actionable sub-fronts, by value)

1. **Promise.prototype.then/.catch/.finally native scheduling (~53%)** —
   biggest lever. Depends on the in-flight host-free async/microtask scheduler
   (#1326 / #1326c / #2895). The `.then(cb)` callback should be lowered to a
   native continuation (closure struct + `call_ref`) registered on a Wasm
   microtask queue, not `__make_callback`. **Blocked on / stacks onto #2895.**
2. **Iterator.prototype.* helpers native bodies (find/map/filter/every/some/
   reduce/forEach/…)** — replace `emitProtoMemberBodyRefusal` for the `Iterator`
   brand with real native bodies that drive the underlying iterator and invoke
   the predicate via `call_ref` on the closure-struct shape. Requires
   `isHostCallbackArgument` to return the closure path for Iterator-brand
   receivers once the native body exists.
3. **`new Promise(executor)` / default-param + async closures** — the
   `(none-detected)` bucket; investigate individually, several likely fold into
   (1).
4. **TypedArray.prototype.forEach/map/…** — small; native %TypedArray% method
   bodies (#2651 family) invoking via `call_ref`.

Each sub-front is a separate PR; (2) and (4) are independent of the async
scheduler and can proceed in parallel once their native bodies are scoped.

## What is explicitly NOT the fix

- Not a `collectCallbackImports` predicate tightening — the closures genuinely
  reach `compileArrowAsCallback` and the call is real.
- Not a finalize-time "unused import" prune — the import is referenced
  (`call 0`); pruning it would break the binary.

## Acceptance (per sub-front)

- Targeted corpus flips host-free: `result.imports` no longer carry
  `__make_callback` AND `WebAssembly.instantiate(binary, {})` succeeds for the
  affected tests.
- gc/host byte-output unchanged (the host path stays for JS-host mode).
- Full `merge_group` net-positive, zero regression.

---

## Landed: sub-front 1 — `.then`/`.catch` bridge dead host-arm de-leak (fable-harvest1, 2026-07-10)

**PR:** `issue-2903-then-chain-deleak`. **Measured yield: +625 host_free_pass**
(the honest #2879 scored metric) with **zero regressions** across every
measured set.

### The post-flip re-ground (why sub-front 1 changed shape)

This issue predates the #2980 carrier-widen FLIP (landed 2026-07-10, PR
#2867). Post-flip, sub-front 1's premise ("the callback must be host-callable
because the host implements `.then`") no longer holds: the bridge
(`emitStandaloneThenWithNativeFallback`, calls.ts) chains native `$Promise`
receivers natively — but it still baked the host `Promise_then*` path into its
`ref.test $Promise` MISS arm, and `emitHostPromiseThenFallback` +
`compileArrowAsCallback` `ensureLateImport`ed `Promise_then/then2/catch` +
`__make_callback` into every standalone module using `.then`/`.catch`.

**Runtime-counted measurement over the whole standalone baseline** (post-flip
`test262-standalone-current.jsonl`, main@34e3812): 662 leaky passes whose ONLY
leaks are then-chain imports; instrumented stubs show the host arm is **never
CALLED in 626 of them** (dead arm — pure accounting loss), live in 36 (31 via
OTHER `__make_callback` sites — Iterator helpers/TypedArray/proxy-toString —
and 4-5 via `.finally`). A 217-file "near-miss" set (then-chain + ≤3 other
imports) splits 90 async-gen-fallback (bridge inactive) / 26 dynamic-import /
~15 allSettled-any-finally chains (genuinely live bridge misses on HOST
promises) / rest other-site `__make_callback`.

### The fix (module-level host-promise-source proof)

The miss arm becomes a **native catchable TypeError** (§27.2.5.4 step 2) —
dropping the imports — exactly when the module **provably cannot mint a host
promise**:

1. **Pre-body syntactic scan** (`ctx.moduleHasHostPromiseSource`,
   declarations.ts collect walk, same discipline as `moduleHasAsyncGen`):
   dynamic `import()`, `.finally(…)`, `allSettled`/`any`/`allKeyed`/
   `allSettledKeyed`/`fromAsync` calls, subclass-receiver `all`/`race`.
   Order-safe for the lazily-registered producers.
2. **funcMap producer check** at bridge emit (`Promise_all/race/allSettled/
   any/finally`, `__dynamic_import`, `__array_from_async`) — the static
   producers register UPFRONT in the `collectPromiseImports` finalize, so this
   is order-safe for them. `Promise_resolve`/`Promise_reject`/`Promise_new`
   are deliberately NOT checked (upfront-registered even when the lowering is
   native → false positive that forfeits the de-leak); the genuine
   `Promise_new` host fallthrough (non-inline executor, new-super.ts) sets the
   module flag at emission instead.

Modules WITH a producer keep the exact pre-#2903 host arm — they were
irreducibly host-import-leaky anyway (the producer import itself), so this
sacrifices zero scored passes.

### Proofs

- 662-set re-measure on the branch: **625 flip to host-free pass**, 36 keep
  their (live) host arms and keep passing, zero pass→fail/CE, 1 pre-existing
  `ret=2` unchanged.
- Near-miss 217-set: **217/217 still pass** (dynamic-import/allSettled/any/
  finally/async-gen behavior preserved).
- `prove-emit-identity`: all 39 (file,target) sha-identical vs main —
  **gc + wasi byte-untouched** (wasi `nullMiss`/zero-import contract intact,
  `tests/issue-1326.test.ts` green).
- 90-file stride sample of standalone async FAILS: zero fail→CE (the throw
  arm validates everywhere), zero unexpected movement.
- New `tests/issue-2903.test.ts` (9 tests): host-free `.then(a,b)`/`.catch`/
  chained/`new Promise(inline)` + catchable-TypeError miss arm + producer
  controls (`.finally`, `Promise.allSettled` keep host arms) + gc/wasi lanes.

---

## Landed: finally sub-front — native `Promise.prototype.finally` (fable-finally, 2026-07-11)

**PR:** `issue-2903-native-finally`. **Measured yield over the whole
`built-ins/Promise` tree (652 files, main@32e1399 vs branch): pass 255→256
(+1), host_free_pass 241→247 (+6), zero HF losses.** Only 2 test262 files
outside the tree use `.finally(` (both top-level-await, skipped), so this is
the full corpus yield. `prove-emit-identity`: all 39 (file,target) emits
sha-identical vs main.

### Why native (what was actually broken on main)

Pre-native, standalone `.finally` on a native `$Promise` receiver routed to
the host `Promise_finally` import, which received a WasmGC struct the host
cannot chain — the import THREW (`p.finally is not a function`), and the
async-call `catch_all` wrap (expressions.ts `wrapAsyncCallInTryCatch`)
swallowed the throw into a rejected-with-NULL `$Promise`. Net effect measured
on main: the onFinally callback silently DROPPED and the rejection reason
identity LOST (a probe chain `reject(err).finally(f).then(_, r)` delivered
`r = null`). Several dir "passes" were `$DONE(null)`-accidents of exactly this.

### The lowering

- `emitStandalonePromiseFinally` + `ensurePromiseFinallyRuntime`
  (async-scheduler.ts): per-site fulfill/reject wrappers call onFinally with
  ZERO args via `call_ref` (try/catch → a throwing onFinally rejects the
  chained promise), then `__finally_after(result, chained, value, isReject)`
  runs the spec `PromiseResolve(onFinally()).then(restore)` step: a throwaway
  pending `$Promise` with the restore reaction PRE-attached is resolved with
  the result (`__promise_resolve_value` — plain fulfil / promise adoption /
  thenable job all reuse the existing substrate). `__finally_restore_settle`
  re-settles the chained promise with the ORIGINAL value (resolve-value) or
  reason (direct reject); `__finally_restore_reject` OVERRIDES with the
  onFinally-result rejection (§27.2.5.3 thrower/valueThunk semantics).
  New scheduler funcIdx side-channels are in ASYNC_SCHEDULER_FUNC_IDX_KEYS
  (the #2918 late-import lockstep).
- calls.ts: Promise-receiver + any-receiver `.finally` arms mirror the
  then/catch bridge (`emitStandaloneFinallyWithNativeFallback`; wasi = direct
  cast / nullMiss). Zero-arg `.finally()` admitted only on the native lane.
- **Producer modules keep the EXACT legacy host route** — the native arms are
  gated on `standaloneThenMissArmCanBeNative` (wasi excepted), because a
  host-promise receiver misses `ref.test $Promise` and the host arm needs the
  async-call fulfilled-wrap to keep behaving as on main (measured:
  subclass-`finally` passes depend on it). The wrap decision is kept in exact
  lockstep with the lowering via a per-node marker
  (`ctx.standaloneNativeFinallyNodes`, read by `isAsyncCallExpression`) —
  funcMap-dependent predicates can drift between the two evaluation points.
- De-leak: `"finally"` removed from `HOST_PROMISE_SOURCE_METHOD_NAMES`
  (declarations.ts) — `.finally`-using modules un-flag for the sub-front-1
  then-bridge de-leak (HF gains include `allSettled/race
  resolved-then-catch-finally.js`). NEW producer flag: `class X extends
  Promise` (heritage scan) — subclass statics mint host promises through a
  symbol-derived import (`FileSystemDirectoryHandle_resolve` — the mislabeled
  lib-interface name) that no funcMap producer list can enumerate; the
  `.finally` syntactic flag had been masking this hole.

### Known accepted delta (documented, not a gate regression)

`prototype/finally/rejected-observable-then-calls-argument.js`: main "passed"
leak-satisfied ONLY because the broken host route nulled the reason
(`$DONE(null)` = falsy = pass). Natively the reason arrives correctly, but the
test's `reason === myError` compare then hits the PRE-EXISTING tag-5
`__any_strict_eq` identity gap (`$AnyValue` object×object → constant 0; the
proper three-way classifier is flag-gated OFF pending #2580 M2 / #3032 — the
dstr-unmask −162 minefield; do NOT flip it piecemeal). The compile-order
mechanism: any module whose FIRST native-promise machinery registration
precedes a later closure compiling `any === any` routes that closure's eq
through the broken helper — already true on main for `.then().then(cb)`
chains (that is `rejected-observable-then-calls.js`'s main failure). Not
host-free on main ⇒ no host_free_pass/floor/gc-lane gate sees it.

### Remaining sub-fronts (issue stays open)

- **Iterator.prototype.* helpers native bodies** (sub-front 2) and
  **TypedArray callback methods** (sub-front 4) — the 31 live
  `__make_callback` residuals.
- The 69-fail "Promise resolve or reject function is not callable" cluster in
  `built-ins/Promise/{all,race,any,allSettled}` (custom-capability tests over
  host combinator imports) is a **different mechanism** (combinator
  capability protocol, #2671's standalone twin) — not part of #2903.
- Tag-5 `__any_strict_eq` object identity (`===` through `$AnyValue` boxes) —
  owned by #2580 M2 / #3032, NOT this issue; see the accepted-delta note.

---

## Landed: sub-front 2 — eager Iterator.prototype helpers, RE-GROUNDED (fable, 2026-07-12)

**PR:** `issue-2903-standalone-callback-leak`.

### Re-ground (the sub-front-2 premise changed on main)

The original sub-front 2 framing — "Iterator helpers leak `env.__make_callback`
because their native bodies are refusal stubs" — **no longer holds**. Verified
2026-07-12 on main: `(g() as any).find(pred)` compiles with **zero env
imports** and instantiates host-free; the callback compiles natively. The
RESIDUAL is **silently-wrong results**: a generator/iterator receiver matches
neither the closed-struct arms (no `<Struct>_find`) nor the vec/$ObjVec HOF arm
in `__call_m_<name>_<arity>`, so it falls to `__extern_method_call`, whose
non-`$Object` arm answers `undefined`. Baseline measured:
`built-ins/Iterator/prototype` standalone = **72/373 pass**.

A second gap surfaced while fixing the first: an `any`-held DRIVEN native sync
generator has **no arm in the `__iterator` GetIterator ladder** (for-of drives
resume functions statically at the call site), so routing one into the ladder
traps `illegal cast`.

### The lowering

- **`src/codegen/iter-hof-native.ts` (new)** — native stepped loops
  `__iter_hof_{find,every,some,forEach,reduce,toArray}` per ES2025 §27.1.4:
  predicate gets `(value, counter)` via `__apply_closure`; early exits run
  IteratorClose; reduce seeds the accumulator from the first step when no
  initial value. Plus three STEPPERS (`__iter_hof_open/_next/_close`,
  reserve-then-fill #1719): `open` is a positive-admission classifier —
  driven-generator frames pass through (the fill bakes per-producer
  `ref.test frame → __gen_resume_*` arms off `ctx.nativeGenerators`, whose
  resume funcs are guaranteed emitted by factory-compile time), ladder-safe
  carriers (canonical `$Vec`, `@@iterator`/`next` closed structs) go to
  `__iterator`, and EVERYTHING ELSE gets a null sentinel → the helpers answer
  the legacy `undefined` (never a trap — class instances / strings / arbitrary
  data structs measured trapping under a naive ladder route).
- **`closed-method-dispatch.ts`** — the fill splits the bottom arm: `$Object`
  receivers keep the open `__extern_method_call` route; other non-vec,
  non-null receivers route to `__iter_hof_<name>`. Reserve hook mirrors #3098.
- `fillIterHofSteppers` wired into index.ts finalize after
  `fillNativeIteratorLateArms`.

### Proofs (all measured on this branch vs main)

- `built-ins/Iterator/prototype` standalone per-file diff: **20 fail→pass,
  ZERO losses** (72 → 92 pass of 373).
- `prove-emit-identity`: all 39 (file,target) sha-identical — gc + wasi +
  standalone example corpus byte-untouched.
- `tests/issue-2903.test.ts` + `tests/issue-1326.test.ts`: 25/25 green.
- Guard probes: class-instance / string / plain-literal receivers answer the
  legacy `undefined` (main behavior), array `.find`/`.reduce` stay on the
  native vec HOF arm, Map/Set `.forEach` unchanged (their any-typed failures
  are PRE-EXISTING on main — `WeakMap_set` import leak, separate issue).

### Boundaries (documented, not gate regressions)

- Helper on a non-iterator receiver → `undefined`, not the spec TypeError
  (same no-throw discipline as `__hof_reduce` #3098).
- Early-exit IteratorClose on a DRIVEN generator frame is a no-op (finally
  blocks not triggered) — §27.5.3.3 boundary.
- Lazy helpers (`map`/`filter`/`take`/`drop`/`flatMap`) are NOT in this slice —
  they need a lazy wrapper-iterator struct (follow-up).
- Plain-`$Object` iterators (`Object.create(Iterator.prototype)` shapes) still
  route to the open arm; dev-iterators' #3146 OBJ-arm additions make them
  drivable by `__iterator`, after which a `$Object`-miss refinement can admit
  them (follow-up).
- Array-iterator reification is a separate gap: `[1,2,3].values()` returns
  NULL standalone, so `.values().find(...)` shapes stay failing (not a helper
  problem).

---

## Re-ground 2026-07-12 (architect, arch-standalone-family-plans) — remaining scope, measured

Fresh-baseline measurement (2026-07-12 standalone JSONL, official scope) +
live compile probes on main @ 6dcdf30135. **The Promise core is DONE**:
`Promise.resolve(1).then(v=>v).catch(e=>e)`, `Promise.all/allSettled([...])`,
`.finally(cb)` all compile with **zero env imports** standalone. Of the 4,467
leaky passes, only **182** are Promise/callback-only (no generator machinery);
the gap map's ~1,500 `Promise_then2/resolve/reject` column co-occurs with
`__create_async_generator` in >90% of rows — it is the async-gen HOST
fallback's own promise traffic and **rides #3132, not this issue**. Family
sequencing lives in umbrella **#3178**.

What remains HERE, ranked, each a bounded PR:

### R1 — `new Promise(NON-inline executor)` (fable-executable-now, S)

Probe: `function make(ex){ return new Promise(ex); } make((res)=>res(42))`
leaks `Promise_new + __make_callback + Promise_then`.
`emitStandalonePromiseFromExecutor` (src/codegen/promise-executor.ts:69)
requires a syntactically inline arrow/fn-expression (it needs the executor's
`ClosureInfo`); an identifier/param-held executor returns `false` and
new-super.ts:3120 sets `ctx.moduleHasHostPromiseSource = true` + falls to the
`Promise_new` import (new-super.ts:3123-3126).

**Fix**: a runtime executor arm. When the executor arg is a VALUE (not an
inline literal), emit: allocate the pending `$Promise`, build the two settle
closures via `ensurePromiseExecutorClosures` (async-scheduler.ts — already
exported for the #3125 thenable jobs; takes the promise local), then invoke
the executor value through the SAME guarded funcref dispatch used for any
2-arg closure call (`emitGuardedFuncRefCast` on the canonical
`(externref, externref) -> ()` wrapper shape; try/catch → reject on throw,
mirroring the inline arm's throw-before-settle handling). Non-callable
executor → native TypeError (§27.2.3.1 step 2). Keep the host arm for gc/host
lanes byte-identical, and drop the `moduleHasHostPromiseSource` flag set for
the newly-native shapes so the then-bridge de-leak applies. Edge cases:
executor called exactly once, synchronously, with (resolve, reject);
re-entrant resolve inside the executor; a zero-param executor value (the
wrapper shape still admits it — verify `make(function(){})`).

### R2 — `class X extends Promise` producer (fable-executable-now, S/M)

Probe: `class P extends Promise {} P.resolve(1).then(...)` leaks
`__new_Promise + FileSystemDirectoryHandle_resolve (the mislabeled
lib-interface name) + __make_callback + Promise_then`. The heritage-scan
producer flag (declarations.ts, added by the finally sub-front) correctly
keeps host arms — but the STATICS route through a symbol-derived import that
is unsatisfiable host-free. **Fix direction**: native subclass statics —
`P.resolve/reject` on a Promise-heritage class allocate the native `$Promise`.
Measure FIRST how many of the ~15 leaky + fail-bucket rows need real
`@@species`/constructor-chain semantics (`instanceof P` on the result); if
species is load-bearing, keep host and document as deferred (graveyard rule:
measure-first honest yield).

### R3 — lazy Iterator helpers `map/filter/take/drop/flatMap` (fable-executable-now, M)

Sub-front 2 covered the EAGER helpers. The lazy five need a wrapper-iterator:
ONE closed struct `$LazyIterHelper { kind i32, src externref,
fn (ref null $wrap2), state (mut f64) }` whose step drives `__iter_hof_next`
on `src` and applies a kind-dispatched transform (map: apply; filter: loop
until predicate true; take/drop: counter in `state`; flatMap: inner-iterator
field, drain-then-advance). Register an arm for it in `__iter_hof_open`
(iter-hof-native.ts) so helpers CHAIN (`g().map(f).toArray()`). ~10 leaky
passes + the `Iterator/prototype/{map,filter,take,drop,flatMap}` fail
directories (~250 files; tree currently 92/373 post-sub-front-2). Follow the
iter-hof-native.ts reserve-then-fill discipline (#1719) exactly.

### R4 — TypedArray callback methods (sub-front 4, fable-executable-now, S)

`Uint8ClampedArray_find + __make_callback` style leaks (~5 rows) + fail rows.
Native %TypedArray% HOF bodies invoking via `call_ref` — same pattern as the
vec HOF arm; ground in `closed-method-dispatch.ts` + the #2651 family.

### NOT this issue (re-affirmed)

- The 69-fail `Promise/{all,race,any,allSettled}` custom-capability cluster
  (combinator capability protocol) — #2671's standalone twin.
- Async-gen promise leaks — #3132. Dynamic-import chains (47) — #1089/#1512.
- for-await-of dstr legacy async lowering (90 leaky) — umbrella #3178 S4.

### Validation (each R-slice)

Leak probe (zero family env imports + bare `{}` instantiate OK), construct-
sampled corpus flip, `prove-emit-identity` gc/wasi byte-identical, merge_group
standalone floor as the decider.

---

## Landed: sub-front R3 — lazy Iterator helpers map/filter/take/drop (opus-r3, 2026-07-13)

**PR:** `issue-2903-r3-lazy-iter-helpers`. **New module
`src/codegen/iter-lazy-native.ts`.**

### The lowering

A single closed struct `$LazyIterHelper { kind i32, src externref, fn externref,
state (mut f64), inner (mut externref) }` (the `inner` field is reserved for a
future flatMap slice — unused here). `.map/filter/take/drop(arg)` on a **non-vec,
non-`$Object` iterator receiver** (generator frame, Map/Set/array iterator, or a
chained lazy wrapper) constructs one via `__iter_lazy_<name>(recv, arg)`, whose
`src` is the OPENED source handle (`__iter_hof_open(recv)` — GetIteratorDirect at
call time). A shared `__lazy_iter_step(wrapper) -> (i32 done, externref value)`
drives `src` through `__iter_hof_next` and applies the kind-dispatched transform:
map applies `fn(value, counter)`; filter loops until truthy; take counts down
`state` (0 ⇒ IteratorClose(src) + done); drop drains `state` skips then passes
through. `fn` invoked via `__apply_closure` — **no `env.__make_callback`, no host
import**.

The wrapper is itself an iterator, wired into BOTH drive paths:
- `closed-method-dispatch.ts` — a lazy arm mirrors the #2903 eager arm's
  non-vec/non-`$Object` split; for map/filter it sits UNDER the #3098 vec HOF arm
  so a vec receiver still eager-maps (arrays keep `[...].map` returning an array).
- `iter-hof-native.ts` `fillIterHofSteppers` — `$LazyIterHelper` arms in
  `__iter_hof_open/_next/_close` (pass-through / `__lazy_iter_step` /
  `__lazy_iter_close`) so `.toArray()`, the eager helpers, and lazy→lazy chaining
  drive it.
- `iter-lazy-native.ts` `fillLazyIterLadderArms` — prepends a `$LazyIterHelper`
  recognition arm to the GetIterator ladder (`__iterator` returns the wrapper,
  `__iterator_next` → `__lazy_iter_step`, `__iterator_return` → `__lazy_iter_close`,
  `__iterator_rest` → `__array_from_iter_n(rec,-1)`) so `Array.from(...)`,
  `[...spread]`, and `for…of` drain it natively.
- `iterator-native.ts` `fillNativeIteratorLateArms` — admits `$LazyIterHelper` to
  the `__array_from_iter_n` drain allowlist (the element-wise drainer the
  `__iterator_rest` arm delegates to).

### Proofs

- `tests/issue-2903-r3.test.ts` (14 tests): map/filter/take/drop via `.toArray()`,
  `Array.from`, `[...spread]`, `for-of`, mapper-counter, lazy→lazy + filter→take
  chaining, empty/`take(0)`/`drop`-beyond edge cases — all **host-free** (`env`
  imports = `[]`, bare `{}` instantiate) + value-correct. Plus eager-array-HOF /
  gc-lane guards.
- `tests/issue-2903.test.ts` + `tests/issue-1326.test.ts`: 25/25 still green
  (then/catch/finally/allSettled de-leak + gc + wasi lanes untouched).
- **gc/wasi byte-identity by construction**: every new path is gated on
  `ctx.standalone`; `$LazyIterHelper` is only registered under standalone, so
  `fillLazyIterLadderArms` and the `__array_from_iter_n` drain-admission no-op in
  gc/host/wasi (structMap miss).

### Boundaries (documented, not gate regressions)

- Helper on a non-iterator receiver → the source handle is null ⇒ the wrapper
  yields nothing, NOT the spec TypeError (same no-throw discipline as the eager
  helpers, #3098).
- `take(n)`/`drop(n)` floor + clamp-negative-to-0, NOT the spec RangeError on
  negative/NaN.
- `result-is-iterator` / `x instanceof Iterator` brand identity is NOT modeled
  (the wrapper is a bespoke struct, not `%IteratorHelperPrototype%`).
- Array-iterator reification is still a separate gap: `[1,2,3].values()` returns
  NULL standalone, so `.values().map(...)` shapes stay failing (not a helper
  problem).

---

## Landed: sub-front R3b — lazy Iterator.prototype.flatMap (opus-r3, 2026-07-13)

**PR:** stacked on `issue-2903-r3-lazy-iter-helpers` (branch
`issue-2903-r3b-flatmap`). Extends the R3 `$LazyIterHelper` with the reserved
`inner` field.

### The lowering

`flatMap` = kind 4 on the SAME `$LazyIterHelper` struct — reuses the R3
constructor (fn = mapper, state = counter). The FLATMAP arm of the shared
`__lazy_iter_step` drains the current `inner` iterator fully before pulling the
next outer value; each `mapper(v, counter)` result is opened into a new `inner`
via **`__iterator(res)`** (the full GetIterator ladder, NOT `__iter_hof_open`),
so typed-vec / `$ObjVec` / array-literal mapper results normalize through the
#3100 vec-family arms while generators, closed iterables, and nested lazy
wrappers (via the R3 `__iterator` prepend) all drive correctly. `inner` persists
in the struct field across steps.

Also: `flatMap` added to the #3098 standalone closure-path exemption in
`calls.ts` (via `LAZY_ITER_METHODS`) — the mapper arrow now crosses as a GC
closure struct (invoked by `__apply_closure`) instead of leaking
`env.__make_callback` (map/filter already had this through `NATIVE_HOF_METHODS`;
flatMap was not in that set).

### Proofs
- `tests/issue-2903-r3.test.ts` (+4, 18 total): array-literal inners,
  generator inners, empty inners, counter, `flatMap(...).map(...)` chaining —
  host-free + value-correct.
- R3 map/filter/take/drop probes unchanged (no regression).

### Boundaries
- A non-iterable non-null mapper result traps (`__iterator` hard-cast) rather
  than the spec TypeError (§27.1.4.6 step 6.b) — the no-throw-boundary
  approximation; the mapper is required to return an iterable.
- Inner iteration via `__iterator` normalizes finite iterables; per-element
  laziness WITHIN an inner is preserved (the ladder is stepped, not
  materialized).
