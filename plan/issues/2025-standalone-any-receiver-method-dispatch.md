---
id: 2025
title: "standalone: any-receiver method dispatch — o.method() on a closed object-literal struct doesn't invoke"
status: in-progress
sprint: 62
created: 2026-06-14
updated: 2026-06-14
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, runtime
language_feature: methods, object-literals, dynamic-dispatch
goal: standalone-mode
related: [2015, 2038, 1888, 1320]
origin: "2026-06-14 #2038 investigation — the standalone analog of #2015 (which fixed only the JS-host any-receiver path)."
---

# #2025 — standalone any-receiver method dispatch (closed object-literal structs)

> Tracking-task name in the board: "#25". Filed as plan issue #2025 for the file.

## Problem

`const o: any = { next() { return 7 }; }; o.next()` returns **0** (should 7)
under both `--target standalone` AND `--target wasi`. Affects EVERY standalone
method call on an `any`/externref object-literal receiver. It is the standalone
analog of #2015 (which fixed only the JS-host proxy/closure dispatch).

Confirmed on main @ 2fecb7f92 (all return 0; expect 7 / 21 / 3):
- `const o:any={next(){return 7}};o.next()`
- `const o:any={x:21,getx(){return this.x}};o.getx()`
- `function mk(){let i=0;return{step(){i=i+1;return i}}};const o:any=mk();o.step();o.step();o.step()`

This is what makes #2038's USER_ITER carrier inert: `userIter.next()` (via the
any-method path) returns null → `done` never truthy → `__iterator_next`
infinite-loops.

## Root cause (WAT-confirmed)

The any-receiver method fallback (`src/codegen/expressions/calls.ts` ~`:7966`,
`isAnyOrExternref` block) routes to the native `__extern_method_call`
(`src/codegen/object-runtime.ts` ~`:4227`). That body is:

```wasm
local.get recv ; any.convert_extern
ref.test (ref $Object)          ;; the OPEN open-hash-map $Object type
(if (result externref)
  (then __apply_closure(__extern_get(recv,name), recv, args))   ;; open-object arm
  (else ref.null.extern))                                       ;; <-- closed structs land here
```

A standalone object literal `{ next(){…} }` compiles to a **closed nominal
WasmGC struct** (a distinct type with named method fields, methods stored as
closures + a sibling `<__anon_N>_<method>(structRef, …args)` func), NOT the open
`$Object`. So `ref.test $Object` is FALSE → else arm → `ref.null.extern`. The
method is never invoked. `__extern_get` has the same `$Object`-only gate, so even
field reads on closed structs return null.

Under `--target wasi` there is an ADDITIONAL failure: the any-method arg-array
build (`calls.ts` `:8068`) only takes the native `$ObjVec` builder branch when
`ctx.standalone`; under `ctx.wasi` it requests `env.__js_array_new` /
`__js_array_push`, which strict-no-host refuses → `arrNewIdx` undefined → the
null fallback at `:8136`. So wasi can't even reach `__extern_method_call`.

## Existing infra that already handles closed structs (verified at runtime)

- `emitMethodDispatch` (index.ts `:2190`) emits **name-specialized type-switch**
  dispatchers over every closed struct that has `<Struct>_<method>`:
  currently only `__call_@@iterator` / `__call_next`. Each does
  `ref.test S / ref.cast S / call S_<method>` and box-coerces the result.
  Runtime-verified: `__call_@@iterator(obj)` + `__call_next(it)` dispatch closed
  structs correctly and thread `this` (the struct is the method's first param).
- `emitStructFieldGetters` (index.ts `:1737`) emits `__sget_<field>` —
  name-specialized type-switch field getters over closed structs (handles
  `value`/`done`).
- `__apply_closure` (object-runtime.ts) threads `this` + args to a closure value.

These are emitted at **FINALIZE** (after all object-literal structs are known),
so a call-site reference to them is a forward reference → reserve-then-fill
(`fillApplyClosure` / `fillProtoIteratorDriver`, #1719) is the established
pattern.

## Fix plan

**Slice 1 (this PR) — generalize closed-struct method dispatch + wasi arg-vec:**
1. Generalize `emitMethodDispatch` to emit `__call_<method>` for EVERY distinct
   method name that appears on any closed object-literal struct (not just
   `@@iterator`/`next`), with **N-ary** support: the dispatcher takes
   `(recv, arg0..argK)` as externref, and for each candidate struct casts recv,
   coerces each externref arg to the method's declared param type, calls
   `S_<method>`, and box-coerces the result back to externref. Track the
   (methodName → max arity) set seen during object-literal compilation in a new
   `ctx.objectLiteralMethodArity: Map<string, number>` so finalize knows what to
   emit.
2. Route the any-receiver call site (`calls.ts` `:7966`) for
   `ctx.standalone || ctx.wasi`: BEFORE `__extern_method_call`, reserve+call the
   `__call_<method>` dispatcher (reserve-then-fill so the finalize-emitted funcidx
   resolves). Keep `__extern_method_call` as the open-`$Object` fallback inside
   the dispatcher's bottom arm (so open objects still work).
3. Make the arg-vec builder branch fire for `ctx.standalone || ctx.wasi` (not
   just `ctx.standalone`) at `:8068` and `emitWrapperDynamicMethodCall` `:1147`,
   so wasi stops requesting refused `__js_array_new`.

**Edge cases / invariants:**
- `this`: the struct IS the method's first param → `this.x` works for free.
- Captured mutable state: lives in module globals today (works for single
  instance; multi-instance aliasing is a separate pre-existing limitation,
  #2012-adjacent — NOT in scope here).
- No closed struct matches AND not open `$Object` ⇒ keep current behavior
  (undefined / refuse), never trap.
- Vec/array/string brands unaffected (gated on the method-name dispatcher set).
- Regression surface: ALL standalone object-literal method calls — validate the
  object-literal + iterator + generator suites byte-compatible, and run a
  scoped standalone test262 slice.

## Acceptance criteria
- The three repros above return 7 / 21 / 3 in standalone AND wasi.
- `__call_<method>` dispatchers dispatch closed structs and thread `this`.
- No regression in JS-host mode (gate strictly on `ctx.standalone || ctx.wasi`).
- Unblocks #2038's USER carrier (`userIter.next()` fires).

## Test files
- `tests/issue-2025.test.ts`: the three repros + a 1-arg method (`add(n)`),
  host/standalone/wasi parity.
