---
id: 2903
title: "standalone: residual env.__make_callback leak is host-backed builtin methods (Promise.then/.catch, Iterator helpers), NOT a callback-representation gap"
status: ready
sprint: Backlog
created: 2026-06-30
updated: 2026-06-30
priority: high
feasibility: hard
reasoning_effort: max
task_type: research+bugfix
area: codegen
language_feature: closures, promises, iterator-helpers
goal: host-independence
related: [2070, 2075, 399, 1326, 1326c, 2895, 2861]
origin: "2026-06-30 standalone __make_callback leak-front investigation (sendev-callback). Verified on main @ 1a53bd8d4, target standalone."
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
