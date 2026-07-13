---
id: 3138
title: "host lane: function-scope fnctor instances never register the instance→ctor link — inherited descriptor/property reads miss (#3022 prototype-chain cluster, ~160 fails)"
status: done
assignee: ttraenkler/fable-harvest2
sprint: 71
created: 2026-07-11
updated: 2026-07-13
completed: 2026-07-11
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
# +85 LOC in new-super.ts: emitCallSiteFnctorRegistration lives beside the
# #1712 prologue registration it complements and its two call sites (fresh +
# cached fnctor-new arms) — splitting one cohesive helper into another module
# to dodge the ratchet would fragment the fnctor-new logic.
loc-budget-allow:
  - src/codegen/expressions/new-super.ts
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
its closure in a _local_ slot, so the gate misses, no registration is emitted,
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
`__fnctor_<Name>_new`) _cannot_ see the caller's local, so the fix must emit
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

## Measured result (fable-harvest2, 2026-07-11, branch vs base dbe58c83366b3)

**+10 genuine flips, 0 regressions.** Every flip verified per-file in
PROCESS ISOLATION on both sides (fails on pristine base, passes on branch):

- `built-ins/Object/defineProperty/15.2.3.6-3-129.js`, `…-3-23.js`
  (inherited data-descriptor attribute via fnctor-instance descriptor)
- `built-ins/Object/create/15.2.3.5-4-{49,102,155,181,190,234,269}.js`
  (descriptor-MAP properties that are fnctor instances with inherited fields)
- `built-ins/String/prototype/trim/15.5.4.20-2-43.js` (inherited `toString`
  on a fnctor instance passed to a builtin)

Zero pass→fail anywhere: full 1,763-file defineProperty{,ies} chunked diff
(one flip total: 129 fail→pass), emit-hash corpus **byte-identical** on both
lanes for module-global fnctors / classes / closures / arrays / strings, and
the adjacent unit suites (issue-1712*, 2608, 2628, 2668, 2680, 3123, relevant
`tests/equivalence/*`) match base exactly (2 pre-existing base failures:
`issue-1712-capture-closure-dispatch`arity-0 case,`new-non-constructor`harness`source.includes` bug — both fail identically on pristine base).

### Measurement-methodology caution (recorded for future harvests)

Chunked in-process batch runs of this corpus are **contaminated**: ~110 files
report a spurious shared "Invalid property descriptor. Cannot both specify
accessors and a value" signature (a prior test's `Object.prototype`/intrinsic
mutation poisons every later test in the process — the same artifact the
#3022 investigation documented), plus a TS-checker poisoning class
("Cannot create property 'declaredType' on number") after ~375 sequential
in-process compiles. Both hit baseline and after runs identically, so diffs
are usable, but ABSOLUTE local counts are not; every flip here was therefore
re-verified per-file in a fresh process. The official CI baseline (isolated
workers) is authoritative for absolute counts.

### Why the ~160 estimate did not materialize (root-cause split)

The "descriptor-reader/prototype-chain ~160" bucket from the 2026-07-09
re-ground conflates ≥3 causes; the instance→ctor LINK (this fix) was only one:

1. **Static-lane define divergence** — the dominant residual (e.g.
   `15.2.3.6-3-133`: `Object.defineProperty(proto, "value", {get})` on a
   proven struct compiles the accessor AWAY into a synthesized typed-struct
   getter (`$__anon_N_get_value`) with **no runtime descriptor-table
   mirroring**, so host-side `_readOwnDescriptor` reads a data field
   `undefined` instead of the accessor. That is precisely **#3043**'s claimed
   scope (fable-3022, in-progress) — deliberately NOT touched here.
2. **Non-fnctor descriptor carriers** — descriptor is a plain function/Array/
   Math object with an attribute inherited via the BUILTIN prototype
   (`Function.prototype.value = "Function"`, `15.2.3.6-3-139-1`): needs a
   closure/builtin-prototype walk in the descriptor reader, not the fnctor
   link. Separate follow-on.
3. **Array-iteration fnctor subclassing** (`foo.prototype = new Array(1,2,3);
f = new foo(); f.every(cb)` — ~150 officially-failing files matched the
   syntactic shape): the link alone does not make inherited INDEX properties /
   reduced `length` visible to the compiled Array.prototype iteration methods.
   Needs the iteration methods' element reads to go through the
   prototype-inclusive MOP for fnctor receivers. Separate follow-on
   (largest remaining sub-bucket of this shape family).
