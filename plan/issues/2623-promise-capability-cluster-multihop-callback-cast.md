---
id: 2623
title: "Promise capability-cluster: multi-hop host→wasm resolve-element callback cast + ctx-ctor species/prototype identity through the bridge"
status: backlog
created: 2026-06-22
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, promise, async, capability-bridge
language_feature: promise, async, proxy
goal: async-model
sprint: Backlog
parent: 1528
related: [2614, 2618, 1373b, 1042, 86, 56]
note: "Spun off from #86 (class-ctor arm, merged) + #55 async-bucket scope (PR #1947). The #56/#1940 closure-construct bridge + #86 executor-call host-routing landed the SURFACE of the capability lane; this issue is the DEEPER shared substrate behind three clusters that the surface fixes did NOT close."
---
# #2623 — Promise capability-cluster: multi-hop host→wasm callback cast + species identity

## Why this exists (one substrate, three clusters)

#56/#1940 (closure-as-dynamic-ctor bridge) and #86/#1945 (capability-ctor
`executor(...)` host-routing) both LANDED. They closed the *surface* of the
capability lane. But a single deeper substrate gap remains, and it is shared by
**three** distinct test262 clusters — fixing it once should bank all three:

1. **#2614 Promise combinator headline rows** —
   `allSettled/call-resolve-element.js`, `race/resolve-from-same-thenable.js`:
   `illegal cast in Constructor()`. The user `Constructor` passes its INNER
   `resolve` (a wasm closure that closes over outer state) to the host
   `executor`; when the host thenable later calls `resolve(value)` BACK, the
   host→wasm callback of that **capturing** closure casts/null-derefs. (#86's
   arm routes the OUTBOUND `executor(...)` call; this is the INBOUND callback.)
2. **#86 capturing-inner-resolve residual** — proven in #86: a NON-capturing
   inner `resolve` works through the arm, a CAPTURING one (`function resolve(){
   calls++; }`) fails the same way. Same root.
3. **await-thenable bucket (#55 scope, PR #1947, ~21 rows)** —
   `await <custom thenable {then(res){res(42)}}>` → `dereferencing a null
   pointer in __closure_N`. `await V` lowers to `Promise_resolve(V)` +
   `Promise_then2(p, __make_callback(continuation))`; for a custom thenable,
   V8's `p.then(resolve,reject)` calls the wasm continuation back as a host→wasm
   callback — the SAME inbound-callback cast/null-deref.

Common shape: **a wasm closure / continuation is handed to host code (a user
`executor`, a custom thenable's `.then`, or V8's NewPromiseCapability) and later
INVOKED BACK by the host**, and that inbound call casts the wasm-closure-struct
arg or null-derefs its captured environment.

## Scope

1. **Inbound host→wasm callback marshalling** — when a wasm closure flows OUT to
   host code (as a `.then`/executor arg, a capability resolve/reject element
   function, an await continuation) and the host calls it back, the inbound call
   must recover the closure struct + its captured environment correctly (no
   unconditional `ref.cast` to a closure struct that fails on the marshalled
   host wrapper; no null-deref of the captured env). The capturing-closure case
   is the hard part — a non-capturing closure has no env to lose.
2. **ctx-ctor species / prototype identity** — `all/allSettled/race/any
   ctx-ctor.js`: `instance.constructor === SubPromise` requires the capability's
   `.constructor`/prototype identity to survive `_wrapCallableForHost`
   (a `.prototype`/species concern on the construct-trap wrapper).
3. **Observable-resolve coupling** (#2614 invoke-resolve all/race) — the
   sandbox-`Promise.resolve` identity fix proven net-negative ALONE in #2614
   (it regressed `any/invoke-resolve` pre-#1940); re-test it composed on top of
   the inbound-callback fix here (the regression was the cross-realm construct,
   which #1940 + this should make legal).

## Gating / discipline

- Bounded-vs-epic TBD: the inbound-callback marshalling touches the hot
  closure-call + host-glue path. Likely needs an architect spec first.
- Broad-impact → validate via merge_group, never a scoped sweep (the #1940/#2615
  eject pattern: PR-level passes, the floor catches the regression).
- Keep any gate SYNTACTIC / narrow to avoid the #1941 host-import LinkError into
  pure-closure programs.

## Expected payoff

#2614 headline rows (call-resolve-element, resolve-from-same-thenable, ctx-ctor,
invoke-resolve) + #86 capturing-inner-resolve residual + await-thenable (~21) +
unblocks #2618 (Proxy apply/construct shares the `__fn_tramp_Constructor`
dispatch). Routed to the #2614/#1528 capability-cluster lane, next-sprint.

---

## Implementation Plan (architect, 2026-06-22 — re-grounded against current main)

### Bounded-vs-epic verdict: **BOUNDED** (3 narrow runtime/codegen slices), NOT epic

The "epic" framing in the parent note was a hedge before the substrate was
pinned. Faithful `runTest262File` re-measure on current main + direct compile
probes show **three distinct, separable, narrow root causes** — each
independently floor-validatable — not one tangled rewrite. Two of them are
**pure `src/runtime.ts`** changes (no codegen ABI churn), and the third
(#2618) is the externref-callee call/construct routing already 90% specced in
the #2618 issue file. None requires a new ABI, a value-rep change, or touching
the `__call_fn_N` dispatcher's funcref-dispatch loop.

### Re-grounding evidence (current main, faithful runner + compile probes)

| Probe | Result on main | What it tells us |
|---|---|---|
| `new this({},input).getLen()` **chained IN-WASM** (acorn `parse()` shape) | **returns 5 ✓** | #2628's headline is ALREADY FIXED in-wasm. The construct-trap `self` IS registered as a fnctor instance (`[protoHook]` fires for `parse` AND `getLen`), so in-wasm `__extern_method_call` resolves the proto method. |
| `Parser.makeViaThis(input)` returned to **host JS**, then `.getLen()` from JS | **THROWS "getLen is not a function"** | The bridge result handed back to the JS harness is a plain `Object` (`constructor.name === "Object"`), NOT a Parser instance — host-side proto dispatch misses. This is the *residual* #2628 gap, but acorn's `parse()` chain is entirely in-wasm so it does NOT block the dogfood lap. |
| `allSettled/call-resolve-element.js` | `fail: illegal cast in Constructor()` | inbound host→wasm callback of a CAPTURING inner `resolve` closure — the user `function Constructor(executor){…}` body casts. **Slice 2614-A.** |
| `race/resolve-from-same-thenable.js` | `fail: illegal cast in Constructor()` | same root as above. |
| `all/invoke-resolve.js` | `fail: returned 2 \| assert #1` | element-identity break (the array round-trip); sd proved the observable-resolve fix net-NEGATIVE alone (regresses `any/invoke-resolve`). **Couples to 2614-A** — deferred to compose ON TOP of the inbound-callback fix. |
| `all/ctx-ctor.js` | `fail: instance.constructor !== SubPromise` | species/prototype identity through the capability bridge. **Slice 2614-B.** |
| `Proxy/apply/call-result.js` | `fail: illegal cast in __call_fn_method_3()` | externref-Proxy callee mis-routed to the `ref.cast $Closure` fast path. **Slice 2618-apply.** |
| `Proxy/construct/call-result.js` | `fail: … is not a constructor` | externref-Proxy constructor + dropped construct-trap result. **Slice 2618-construct.** |

### Root cause (one substrate, two mechanisms)

**Mechanism (a) — inbound host→wasm callback of a CAPTURING closure.**
When a wasm closure flows OUT to host code (the user `executor`'s inner
`resolve`, a custom thenable's `.then` continuation, an await continuation) and
the host invokes it BACK, the host either (i) holds the **JS wrapper Function**
produced by `_wrapWasmClosureUnknownArity` / `_wrapCallableForHost`, or (ii)
re-passes the value through a path that lost the raw struct. The inbound entry
`__call_fn_N` / `__call_fn_method_N`
(`emitClosureCallExportN`, `src/codegen/index.ts:3218`) does
`local.get 0 → any.convert_extern → ref.test/ref.cast` against the closure base
wrapper (`index.ts:3322-3324` + the per-entry funcref dispatch). **It never
unwraps a host wrapper back to the raw struct first** — so when the inbound
value is the wrapper Function (not the struct), `ref.test` misses every arm and
the dispatch either falls to `ref.null.extern` (→ caller null-deref of the
captured env) or a downstream `ref.cast` traps (`illegal cast in Constructor()`).
A NON-capturing inner resolve survives because it has no captured env to lose
and its wrapper round-trips trivially; a CAPTURING one
(`function resolve(){ calls++; }`) is the failing case (the #86 residual). The
bidirectional map already exists — `_wasmClosureWrapperTargets`
(Function→struct, `runtime.ts:1750`) and `_unwrapForHost`/`_hostProxyReverse`
(`runtime.ts:4092`) — it is simply **not consulted on the inbound `__call_fn_*`
arg path**.

**Mechanism (b) — `__construct_closure` result identity + species.**
`__construct_closure` (`runtime.ts:9389`) returns
`Reflect.construct(_wrapCallableForHost(callee), args)`. The callable wrapper's
`construct` trap (`runtime.ts:4904-4918`) builds a fresh **plain JS `self = {}`**,
runs the body on it, and returns `self`. So the result (1) is NOT linked to the
constructor closure via `_fnctorInstanceCtor` for HOST-side proto dispatch, and
(2) carries no `.constructor`/`.prototype` species identity
(`instance.constructor === SubPromise` fails — `ctx-ctor`). In-wasm dispatch
works because the `self` does get registered for the in-wasm read path (proven
by the `[protoHook]` trace), but the host-facing identity is lost.

### Slice plan (each independently floor-validatable; broad-impact → merge_group)

The slices are ordered so the keystone (2614-A inbound marshalling) lands first;
everything else composes on top. Each slice is its own PR with its own
merge_group floor validation (per `project_broad_impact_validate_full_ci` — the
inbound-callback path is a hot closure-call site; a scoped sweep WILL hide
regressions, exactly the #1940/#2615 eject pattern).

---

**Slice 2623-A — inbound capturing-closure marshalling (KEYSTONE).**
*Flips:* `allSettled/call-resolve-element`, `race/resolve-from-same-thenable`,
the #86 capturing-inner-resolve residual, and the await-thenable bucket (~21:
`await <custom thenable {then(res){res(42)}}>` → `__closure_N` null-deref).

**File: `src/runtime.ts`** — the OUTBOUND wrap side is where the raw struct is
still in hand; ensure every closure that flows to host as a callback argument is
wrapped through `_wrapWasmClosureUnknownArity` (which already records
`_wasmClosureWrapperTargets[wrapper] = struct` at `runtime.ts:1916`) so the
reverse map is always populated. Audit the executor-call host-routing arm (the
#86 arm) and the `.then`/thenable assimilation path (#2613) to confirm the inner
`resolve`/`reject`/continuation closures are wrapped via this helper (not handed
to the host as raw structs or via a path that skips the target-map write).

**File: `src/codegen/index.ts`** — `emitClosureCallExportN` (line 3218), the
inbound dispatcher. After `local.get 0` / `any.convert_extern` (line 3322-3324)
the value is tested against the closure base wrapper. **Problem:** when the host
calls back with the JS wrapper Function, the externref arriving at slot 0 is the
wrapper, not the struct. The fix is host-side, not wasm-side: the wrapper
Function's own body (`wasmClosureDynamicBridge`, `runtime.ts:1880`) ALREADY
forwards to `exports.__call_fn_method_${arity}(rawThis, closure, …)` with the
**raw `closure` struct** captured in its lexical scope — so when the host calls
the wrapper, the raw struct is recovered. The failing case is when the host
passes the wrapper as an **argument** to ANOTHER wasm closure (the executor
receives `resolve` as a param), and that inner closure is later dispatched with
the wrapper-as-externref-arg. **Fix locus:** in `emitClosureCallExportN`'s
`buildArgConversion` (line 3331), for an `externref`/`anyref` closure-call
**argument** that is itself a wasm-closure wrapper, the arg must be unwrapped to
the raw struct before it feeds the inner `call_ref`. The host already exposes
the reverse map; add a runtime helper `__unwrap_closure(externref) → externref`
(returns `_wasmClosureWrapperTargets.get(v) ?? _unwrapForHost(v) ?? v`) and call
it in `buildArgConversion` when the param is a reference kind that could hold a
marshalled closure. Gate SYNTACTICALLY narrow (only the closure-arg path, only
JS-host) to avoid the #1941 LinkError into pure-closure programs.

*Wasm IR pattern (argument unwrap in the dispatcher arm):*
```wasm
;; buildArgConversion for a reference-kind closure-call arg
local.get $argN              ;; externref (possibly a wrapper Function)
call $__unwrap_closure       ;; → raw struct externref if it was a wrapper, else passthrough
any.convert_extern           ;; existing lowering continues
(ref.cast $closureParamType) ;; existing, when the param is a concrete ref
```
*Edge cases:* (1) arg is a real host function (not a wasm wrapper) → passthrough
unchanged. (2) arg is a non-closure struct → passthrough. (3) capturing vs
non-capturing — both go through the same unwrap; non-capturing was already
green, must stay green. (4) standalone — `__unwrap_closure` is JS-host-only; the
helper must dead-elim to nothing when no host imports (no LinkError).
*Validation:* the four named rows above + a `tests/issue-2623.test.ts` with a
capturing inner-resolve executor + a custom-thenable await. **merge_group floor
mandatory** — this is the closure-call hot path.

---

**Slice 2623-B — `__construct_closure` host-side instance identity + species.**
*Flips:* `all/allSettled/race/any ctx-ctor` (`instance.constructor === SubPromise`)
and the host-side residual of #2628 (`new this(...)` result returned to host JS,
then `.method()` — the `viaThis` repro, currently `constructor.name === "Object"`).

**File: `src/runtime.ts`** — `_wrapCallableForHost`'s `construct` trap
(line 4904). Instead of building a bare `self = {}`, the trap should produce an
object whose `[[Prototype]]` is the closure's vivified `.prototype`
(`_getOrVivifyFnPrototype(closure, callbackState)`), and register it via
`_fnctorInstanceCtor.set(result, closure)` so BOTH the in-wasm
(`_fnctorProtoLookup`) and host-side (`Object.getPrototypeOf`) dispatch resolve.
Concretely: `const proto = _getOrVivifyFnPrototype(closure, callbackState);
const self = proto && typeof proto === "object" ? Object.create(proto) : {};`
then after the body runs, `if (result is the fresh self) _fnctorInstanceCtor.set(result, closure)`.
`Object.create(proto)` gives the host `.constructor`/`.method()` chain for free
(proto.constructor is set by the existing fnctor machinery), closing `ctx-ctor`.

**File: `src/runtime.ts`** — `__construct_closure` import (line 9389). After
`Reflect.construct`, if the result is a fresh ordinary object (not an object the
body explicitly returned), ensure the `_fnctorInstanceCtor` link is set (belt
and braces — the trap already does it; this covers the direct-`__construct_closure`
entry that bypasses the trap's ordinary path). One terminal write, no funcidx
shifts (pure runtime).

*Edge cases:* (1) body explicitly returns an object (`return {x:9}`) → that
object is the result per §10.2.2; do NOT re-link to the ctor proto (matches
`Proxy/construct/call-result` semantics too). (2) closure has no vivified
prototype yet → fall back to `{}` (current behavior, no regression). (3)
`@@species`/subclass — `ctx-ctor` reads `instance.constructor`; once the proto
chain is correct, `constructor` resolves through it.
*Validation:* the four `ctx-ctor` rows + the host-side `viaThis().getLen()`
repro flipping to 5. Pure-runtime → still merge_group-validate (broad: every
`__construct_closure` consumer, incl. acorn `new this`).

---

**Slice 2623-C — Proxy apply/construct (unblocks #2618).**
*Flips:* `Proxy/apply/call-result`, `apply/call-parameters`,
`construct/call-result`, `construct/call-parameters`, `construct/trap-is-*`
(~15 gc rows). **This is #2618** — its issue file already carries the 3-change
plan; this slice is the "sequence-after-#56/#86" trigger. With 2623-A landed,
the externref-Proxy callee `.call()`-in-capture regression that blocked the
#2618 prototype (the `apply/return-abrupt.js` PASS→ERR) is resolved by the same
inbound-marshalling unwrap, so #2618's apply path can now land without the
regression.

**File: `src/codegen/expressions/calls.ts`** — a callee whose storage slot is
`externref`/`any` (a `new Proxy` local) must route `p(args)` through the dynamic
`__call_function`/`__apply` boundary, NOT the `ref.cast $Closure` fast path.
**File: `src/codegen/statements/variables.ts`** — the `isCallable` branch must
NOT recast a `new Proxy` externref to a `$Closure` struct (add the Proxy guard
mirroring the `isBindHostCall` branch, per #2618 finding-2).
**File: `src/codegen/expressions/new-super.ts`** — `tryEmitDynamicNew` /
`emitDynamicNewFallback` (line 1728): when the constructor value is an externref
Proxy, route through the host `[[Construct]]` boundary
(`_hostProxyConstruct`-class, `runtime.ts:5037`) and USE its return value as the
result object (§10.5.13 / §9.3.2). **File: `src/runtime.ts`** — the target-wrap
change (#2618 finding-1: `_maybeWrapCallableUnknownArity` a callable target
before `new Proxy(target, handler)`) is clean and can land here.

*Edge cases:* per #2618 issue file (apply-trap-absent → forward to target
`[[Call]]`; construct-trap-absent → forward to target `[[Construct]]`;
construct returns non-object → §10.5.13 TypeError via #2617 boundary
propagation; `new.target` threading for `construct/call-parameters-new-target`).
*Validation:* the ~15 `built-ins/Proxy/{apply,construct}` rows + the existing
`tests/issue-2618.test.ts` plan. Broad (call/construct dispatch selection) →
merge_group.

---

### Coupled / deferred (do NOT bundle into A/B/C)

- **`invoke-resolve` element-identity break** (`all/race`) — sd proved the
  observable-resolve fix net-NEGATIVE *alone* (regressed `any/invoke-resolve`
  pre-#1940). Re-test it COMPOSED on top of 2623-A as a follow-up slice 2623-D,
  AFTER A lands and the cross-realm construct is legal. File forward; do not
  gate A/B/C on it.

### Sequencing summary

```
2623-A (inbound capturing-closure marshalling)  ──► keystone, lands first
   ├─► 2623-B (construct_closure identity + species)   independent, can parallel A
   ├─► 2623-C == #2618 (Proxy apply/construct)          DEPENDS on A (removes the
   │                                                     .call()-in-capture regr)
   └─► 2623-D (invoke-resolve observable-resolve)       follow-up, compose on A
```

A and B are pure-runtime + one codegen helper (~80-120 LoC each). C is the
already-specced #2618 (~150 LoC across 4 files). Each is its own PR, each
merge_group-floor-validated, none touches the value-rep substrate (#2580) or the
`__call_fn_N` funcref-dispatch loop body.

### Bounded-vs-epic, restated

**BOUNDED.** The substrate is one missing unwrap on the inbound closure-arg path
plus one identity link on the construct-trap result — both leverage maps that
already exist (`_wasmClosureWrapperTargets`, `_fnctorInstanceCtor`,
`_hostProxyReverse`). No new ABI, no dispatcher rewrite, no value-rep change.
The risk is regression breadth (hot closure-call path), addressed by
merge_group floor validation per slice — NOT by scope.
