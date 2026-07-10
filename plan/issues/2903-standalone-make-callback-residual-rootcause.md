---
id: 2903
title: "standalone: residual env.__make_callback leak is host-backed builtin methods (Promise.then/.catch, Iterator helpers), NOT a callback-representation gap"
status: ready
sprint: current
created: 2026-06-30
updated: 2026-07-10
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
loc-budget-allow:
  - src/codegen/expressions/calls.ts
  - src/codegen/declarations.ts
  - src/codegen/context/types.ts
  - src/codegen/expressions/new-super.ts
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

### Remaining sub-fronts (issue stays open)

- **Native `.finally`** (§27.2.5.3 over the native then machinery) — removes
  the `Promise_finally` producer; folds the 4-5 finally-live leaky passes and
  un-flags `.finally`-using modules for the de-leak (~30-file
  `prototype/finally` dir). Pre-existing gap: `.finally` on a native-$Promise
  chain drops the callback under the leak-satisfied runner too (probed
  identical on main — NOT a regression of this PR).
- **Iterator.prototype.* helpers native bodies** (sub-front 2) and
  **TypedArray callback methods** (sub-front 4) — the 31 live
  `__make_callback` residuals.
- The 69-fail "Promise resolve or reject function is not callable" cluster in
  `built-ins/Promise/{all,race,any,allSettled}` (custom-capability tests over
  host combinator imports) is a **different mechanism** (combinator
  capability protocol, #2671's standalone twin) — not part of #2903.
