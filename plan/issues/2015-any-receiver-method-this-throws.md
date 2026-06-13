---
id: 2015
title: "method call using `this` on an any-typed object-literal receiver throws bare WebAssembly.Exception (__extern_method_call this-routing)"
status: suspended
sprint: 62
created: 2026-06-10
updated: 2026-06-12
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: host-interop
language_feature: objects
goal: core-semantics
related: [1971]
origin: "2026-06-10 spec-conformance sweep (objects agent): verified on main"
---

# #2015 — this.<field> inside method invoked via extern dispatch traps

## Problem

```ts
const o: any = { x: 21, getx() { return this.x; } };
o.getx()
// wasm: throws bare WebAssembly.Exception (no message)   node: 21
```

The same literal with a *typed* receiver (`const o = {...}`) works.

## Root cause

`src/codegen/expressions/calls.ts:7512` — any/externref receivers dispatch
through `__extern_method_call(obj, name, args)`; the runtime method
wrapper (`src/runtime.ts:~6815`) invokes the compiled method with the
wrapped mirror receiver, and the method body's `this.<field>` path throws
inside wasm (mirror is not the struct the body expects). Exact inner
mechanism needs follow-up triage during fix.

## Fix direction

Pass the original struct ref (not the host mirror) as `this` when the
method is a compiled wasm function; reserve the mirror for genuine host
objects.

## Acceptance criteria

- Repro returns 21; typed-receiver calls unchanged
- Error, if any path remains unsupported, must be a catchable TypeError

## Dupe check

#1017/#1022/#1038 older done-era; #1971's method finding is null class
receivers. New.

## Suspended Work (2026-06-13, dev-c) — CORRECTED root cause

- **Worktree**: `/workspace/.claude/worktrees/issue-2015-any-receiver-this`
  (branch `issue-2015-any-receiver-this`, NO code committed — analysis only;
  one wrong-path runtime attempt was reverted).

### The issue's cited root cause is WRONG — this is NOT an `__extern_method_call` bug
WAT-traced `o.getx()` on the repro (`const o: any = { x: 21, getx() { return
this.x; } }; o.getx()`): the compiled `$test` uses **`__call_fn_0` + `call_ref`
+ a `getx_`-named function** and does **NOT** emit `__extern_method_call` /
`__proto_method_call` / `__extern_get` at all. So despite the `any` annotation,
the compiler statically resolves the object-literal's shape and calls the
`getx` closure **directly** — it just fails to thread the receiver struct as the
method's `this`. The runtime `__extern_method_call` / `_wrapForHost` path
(cited at calls.ts:7512 / runtime.ts:~6815) is never reached.

A runtime fix attempt (unwrap the host-proxy `this` via `_hostProxyReverse` in
`_wrapWasmClosureUnknownArity`'s `__call_fn_method_N` bridge, runtime.ts:~1812)
had **no effect** — confirming the dispatch doesn't go through that bridge.

### Where the real fix is
`src/codegen/expressions/calls.ts` — the **static closure-call path** for a
method access on an any/externref receiver (the `__call_fn_0`/`call_ref` arm,
near the closure-call helpers at ~1345-1360 and the method-call resolution that
picks `closureInfoByTypeIdx`/`closureMap`). When the callee is an object-literal
**method** closure (not a free function), the receiver struct must be threaded
as `this` — either as the method's `__self`/first param, or via the
`__current_this` global (the mechanism class methods already use; grep
`__current_this`, set #1636-S1). Today the closure is called with only its
captured args, so `this.<field>` (a `struct.get` on a null/absent `this`) traps.

### Resume steps
1. In calls.ts, find the arm that compiles `recv.method()` where `recv` is
   any/externref and `method` resolves to an object-literal closure field
   (produces `__call_fn_0`/`call_ref`). Confirm via WAT that the repro hits it.
2. Compare with the CLASS method path (typed receiver works — `o.getx()` on a
   non-`any` receiver returns 21) to see how `this` is threaded there
   (`emitClosureCall*`, the `__current_this` set, or a self param), and mirror it.
3. Thread the receiver struct as `this` for the object-literal-method closure
   call. Guard: free-function closure calls (no receiver) must stay unchanged;
   the no-`this` method control (`{ getx() { return 5; } }`) already works.
4. Equivalence test: any-receiver method using `this.x` → 21; typed-receiver
   unchanged; no-`this` method unchanged; method mutating `this.x` then reading;
   nested `this` in a method calling another method.

### Repro (verified on main)
`const o: any = { x: 21, getx() { return this.x; } }; o.getx()` → wasm throws
bare WebAssembly.Exception; node 21. Typed receiver (`const o = {...}`) → 21.
no-`this` method (`{ getx() { return 5; } }`) → 5 (works).

### Why suspended
`reasoning_effort: high`; the issue's diagnosis was wrong (runtime vs codegen),
so the real fix is a codegen this-threading change with regression risk across
the closure-call paths. Warrants a focused pass / senior-dev with the corrected
analysis above rather than a rushed change at session tail.
