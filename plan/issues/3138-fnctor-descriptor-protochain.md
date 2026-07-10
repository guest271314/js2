---
id: 3138
title: "host lane: function-scope fnctor instances never register the instance→ctor link — inherited descriptor/property reads miss (#3022 prototype-chain cluster, ~160 fails)"
status: in-progress
assignee: ttraenkler/fable-harvest2
sprint: current
created: 2026-07-11
updated: 2026-07-11
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime
language_feature: object-defineproperty, prototype-chain
es_edition: 5
goal: correctness
test262_category: built-ins/Object/defineProperty, built-ins/Object/defineProperties
related: [3022, 1712, 2680, 3123]
umbrella: 3022
origin: "2026-07-11 — cause-scoped pickup of the #3022 'descriptor prototype-chain / fnctor reads' senior cluster (dev-3022 cause 3, re-measured ~160 by fable-3022 on 2026-07-09)"
---

# #3138 — function-scope fnctor instances: no instance→ctor link, inherited reads miss

## Problem

The test262 shape (e.g. `built-ins/Object/defineProperty/15.2.3.6-3-129.js`):

```js
var proto = { value: "inheritedDataProperty" };
var ConstructFun = function () {};
ConstructFun.prototype = proto;
var child = new ConstructFun();
Object.defineProperty(obj, "property", child); // descriptor's `value` is INHERITED
```

Under the runner wrap, the body lives inside `export function test() { try { … } }`,
so `ConstructFun` is a **function-local** binding. `new ConstructFun()` compiles
via `compileNewFunctionDeclaration` (new-super.ts), whose #1712 instance→ctor
registration (`__register_fnctor_instance`, emitted in the ctor prologue) is
gated on `ctx.moduleGlobals.get(funcName) ?? ctx.funcClosureGlobals.get(funcName)`
— the ctor closure must live in a **module global**. A function-scope fnctor has
its closure in a *local* slot, so the gate misses, no registration is emitted,
and `_fnctorInstanceCtor` has no entry for the instance.

Everything downstream is already correct (verified by instrumentation on main
@ ec5958aff018a): `__defineProperty_desc`'s field reader consults
`_fnctorProtoLookup` per descriptor attribute (#2680), and the walk itself
handles WasmGC-struct ancestors (`_readOwnDescriptor`). The ONE missing link is
the registration: `hasCtor=false` for every lookup.

## Root cause

`src/codegen/expressions/new-super.ts` `compileNewFunctionDeclaration` (~L1431):
the prologue registration reads the ctor closure from a module GLOBAL, which
does not exist for function-scope fnctors. The prologue (inside the synthesized
`__fnctor_<Name>_new`) *cannot* see the caller's local, so the fix must emit
the registration at the **call site**, where the closure local IS in scope.

## Fix (call-site registration, host lane only)

At each fnctor-`new` call site — both the fresh-compile emission at the end of
`compileNewFunctionDeclaration` and the `funcConstructorMap` cached arm in
`compileNewExpression` — when ALL of:

- host lane (`!ctx.standalone && !ctx.wasi`),
- the module-global gate missed (no `moduleGlobals`/`funcClosureGlobals` entry
  — i.e. the prologue registration was NOT emitted),
- `fctx.localMap` has a slot for `funcName` holding the closure value
  (externref or a concrete closure-struct ref; ref-cell boxed captures are
  skipped — status quo),

emit after the ctor `call` (stack: `(ref null $__fnctor_<Name>)` instance):

```
local.tee $__fnctor_reg_tmp     ;; keep the typed instance
extern.convert_any              ;; instance → externref
local.get $<funcName>           ;; closure value (+ extern.convert_any if a GC ref)
call $__register_fnctor_instance
local.get $__fnctor_reg_tmp     ;; restore — result type unchanged
```

`ensureLateImport` + `flushLateImportShifts` AFTER the ctor call is emitted,
then a fresh `funcMap` lookup for the register import (the #2608 "one terminal
flush, never mid-emission" discipline). Stack-balanced; result type identical;
standalone/wasi byte-identical; module-global fnctors byte-identical (gate).

Runtime handlers (`runtime.ts` 9329 / 14201) are already null-tolerant.

## Acceptance criteria

- `15.2.3.6-3-129`-family inherited-descriptor-attribute tests flip to pass.
- Measured test262 delta over the `built-ins/Object/defineProperty{,ies}`
  corpus (before/after via `runTest262File`) is positive with zero regressions.
- Standalone lane byte-identical (host-gated); module-global fnctor programs
  byte-identical (gate check).
