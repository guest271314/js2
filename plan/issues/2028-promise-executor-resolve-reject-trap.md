---
id: 2028
title: "new Promise(executor): invoking the host-provided resolve/reject from wasm traps null deref — executor pattern fully broken in JS-host mode"
status: ready
sprint: 62
created: 2026-06-10
updated: 2026-06-12
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: host-interop
language_feature: promises
goal: core-semantics
related: [1950, 1382, 1042, 1326]
origin: "2026-06-10 spec-conformance sweep (async agent): verified on main"
---

# #2028 — host functions flowing INTO wasm as callable params have no bridge

## Problem

```ts
return new Promise<string>((resolve) => { resolve("ok"); });
// wasm: RuntimeError: dereferencing a null pointer at __cb_0
//       (thrown synchronously during new Promise)
// node: promise resolving "ok"
```

Reject path identical — `.catch` receives the RuntimeError, not the
intended reason. Every executor probe (sync resolve, resolve-twice,
reject-after-resolve, via .then, throw-in-executor) hits the same trap.

## Root cause

`src/codegen/expressions/new-super.ts:1748` bridges the executor closure
to the host `Promise_new` import (`src/runtime.ts:7954`, wrapped via
`callback_maker` at `src/runtime.ts:8904`). Inside the lifted callback the
host JS functions `resolve`/`reject` arrive as plain externref, but the
call site compiles them through the WasmGC closure-struct path
(`src/codegen/expressions/calls-closures.ts:568` ref.test/ref.cast +
`struct.get` + `call_ref`) — the cast fails → null → trap.
Host-function-as-callable-param is the inverse of #1382 (wasm closure →
JS-callable) and the same trap mechanism as #1950 (different direction).

## Fix direction

In the closure call path, when the callee value is externref (or the cast
fails), fall back to a host `__call_extern_fn(fn, args)` import instead of
trapping. That bridge also unblocks other host-function-param patterns.

## Acceptance criteria

- Repro resolves "ok"; reject path delivers the reason to .catch
- resolve-twice / reject-after-resolve ignored per §27.2.1.3
- Wasm-closure params unchanged

## Dupe check

#1382 (done) opposite direction; #1950 (ready) wasm closures stored via
push/Map.set. No issue covers host functions as params. New.

## Note for #1042

The async agent also confirmed #1042's scope: `await` on real host
promises never unwraps (NaN values, "132" vs "123" ordering, uncatchable
rejections). #1042's claim that "trivial `Promise.resolve(x)` patterns
work" is stale — `await Promise.resolve(41)` now yields NaN inside wasm.

## Implementation Plan

### Root cause
`new Promise(executor)` (host mode) is bridged at `new-super.ts:1807-1826`: the
executor closure is passed to host `Promise_new` (`runtime.ts:9522`), which wraps
it via `_maybeWrapCallable`→`_wrapWasmClosure` (runtime.ts:1747) so the host can
call `executor(resolve,reject)`. The host JS `resolve`/`reject` are passed into the
wasm closure body as externref params. Inside, `resolve("ok")` is a call whose
callee is a parameter holding a foreign JS function as a plain externref. The
closure-call dispatch (`calls.ts:8970-9000`) compiles it through the WasmGC
closure-struct path (`any.convert_extern`→`emitGuardedRefCast`→`struct.get 0`→
`call_ref`); the guarded cast nulls (a host fn is not a `$closure` struct) and the
struct.get traps: "dereferencing a null pointer".

The existing `__call_function` host fallback (#1712, calls.ts:9063-9159) handles
exactly this but is gated by `calleeMayBeHostCallable` (calls.ts:909), which only
fires for a var initialized from a host-builtin member — the executor's
resolve/reject arrive as function PARAMETERS, so the gate returns false and no
fallback arm is emitted.

### Fix direction
Widen the host-callable fallback so a callee that is a function parameter whose
runtime value may be a foreign callable gets the `__call_function` arm instead of
trapping. `__call_function(fn,thisArg,argsArray)` is already wired — no new import.

### Changes
- `calls.ts` `calleeMayBeHostCallable` (909): add a clause returning true when
  `expr` is an Identifier resolving to a PARAMETER whose local wasm type is
  `externref` (not a `ref $closure`) and whose declared type is a call signature.
  Be conservative: only externref params (a closure-struct param keeps the fast
  `call_ref` path and must NOT pull host imports — #1941 dual-mode constraint).
- Dispatch arm 9063-9159 already builds the guarded `__call_function` fallback;
  with the gate widened the executor call emits both arms (cast succeeds→call_ref;
  cast nulls→__call_function). Reuse the #1712 structure verbatim.
- `new-super.ts:1807-1826`: no change to the bridge; add a comment cross-ref.
- `runtime.ts` `__call_function`: confirm it tolerates a host fn; if it assumes a
  wasm-closure fn, add a `typeof fn === "function"` direct-call fast-path.

### Edge cases
sync resolve→"ok"; reject(reason)→`.catch` gets reason not RuntimeError;
resolve-twice/reject-after-resolve→ignored, host `new Promise` enforces
`[[AlreadyResolved]]` (§27.2.1.3) once the call reaches __call_function — no wasm
guard; sync throw in executor→host wrapper rejects per §27.2.3.1 step 9 (verify the
wasm exception surfaces as a thrown JS value across `__call_fn_2`; if it traps,
note as separate hardening); non-callable executor→host throws TypeError;
**dual-mode**: keep the widened arm host-mode-only (`!standalone && !wasi`, already
the gate at calls.ts:9083) — standalone `new Promise` is the native-`$Promise` path
(#1326); ensure the widened clause does not fire in standalone; **#1941 regression
guard**: pure local-closure programs must NOT pull `__js_array_new`/`__call_function`
(externref-only param restriction ensures this).

### Test-gate plan
`tests/issue-2028.test.ts`: `new Promise<string>((resolve)=>resolve("ok"))`→"ok";
reject delivers reason; resolve-twice ignored; throw-in-executor rejects. test262
`built-ins/Promise/executor-*.js`, `resolve-function-*`, `reject-function-*`,
`create-resolving-functions-resolve.js`/`-reject.js`,
`exception-after-resolve-in-executor.js`. Regression: `tests/equivalence/*closure*`
show no new host imports for pure local-closure cases (assert no `__js_array_new`).

### Spec citations
Promise constructor + resolving functions §27.2.3.1 steps 8-10; CreateResolvingFunctions
`[[AlreadyResolved]]` §27.2.1.3; resolve/reject §27.2.1.3.2/§27.2.1.3.1.

## Root-cause re-analysis (se1, 2026-06-16, sprint 62) — SPEC IS STALE

The documented root cause ("`resolve("ok")` traps null-deref via the closure-
struct dispatch; widen `calleeMayBeHostCallable`") **no longer reproduces on
current main** (`90d965220`). Verified end-to-end:

- The synchronous `RuntimeError: dereferencing a null pointer` is **gone**.
  `new Promise<string>((resolve) => resolve("ok"))` now returns a real host
  `Promise` (instanceof Promise) that **never settles** — no trap, no throw,
  the `.then`/`.catch` callbacks never fire.
- Instrumenting an observable side effect in the executor body (`log = 1;
  resolve("ok"); log = 2;`) shows **`log === 0` after `makeOk()`** — i.e. the
  **executor body never runs at all**.

### What actually happens

`new-super.ts:1848-1867` lowers `new Promise(executor)` as
`compileExpression(executor, externref)` → `call Promise_new`. The executor
arrow is compiled to a **synthetic callback** (`$__cb_0`, registered via
`__make_callback`), NOT a closure struct. At runtime the raw value arriving at
the host `Promise_new` is already `typeof === "function"` (the `__make_callback`
wrapper), so `_maybeWrapCallable(fn, 2)` returns it as-is and native
`new Promise(fn)` calls `fn(resolve, reject)`.

But calling that `__make_callback`-produced wrapper with two real JS functions
**does not dispatch `exports.__cb_0`** — resolve/reject are never invoked and no
exception is thrown (confirmed by hooking every host import: only
`__make_callback` fires during `makeOk()`; `__js_array_new` / `__call_function`
never fire even though `$__cb_0`'s body contains the host-call arm). So the bug
is in the **`__make_callback` id-dispatch / `Promise_new` executor-invocation
bridge** (the #1042/#1326 synthetic-callback machinery), upstream of and
unrelated to the closure-call `struct.get` trap the spec targeted.

### Disposition

- The spec's `calleeMayBeHostCallable` widening was implemented and **does
  correctly remove the (no-longer-occurring) null-deref trap class** for an
  externref-typed callable parameter — a safe hardening — but it is **not
  sufficient**: the executor body never executes, so widening the in-body call
  dispatch can't make resolve/reject settle the promise. Implemented change
  reverted to avoid shipping a behaviourally-inert diff under a "fixed" label.
- **Needs re-spec.** The real fix lives in the `__make_callback` /
  `compileSyntheticAsyncContinuation` host-side dispatch (why does invoking the
  wrapper not reach `__cb_0`?) and/or the `new-super.ts` Promise-executor bridge
  (should the executor be lowered as a closure struct passed to `Promise_new`
  rather than a synthetic `__cb` callback?). This is entangled with the
  async-cps continuation infrastructure (#1042/#1326) — route to architect for a
  fresh `## Implementation Plan` against current main before re-dispatch.
- Acceptance criteria (resolve "ok" / reject reason / resolve-twice ignored)
  remain UNMET; left at `ready` with this updated analysis.
