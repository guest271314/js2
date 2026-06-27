---
id: 2628
title: "compiled-acorn: method call on a __construct_closure-constructed instance fails (5th dogfood blocker)"
status: done
sprint: 67
completed: 2026-06-27
assignee: ttraenkler/dev-acorn-construct
created: 2026-06-22
priority: high
feasibility: medium
reasoning_effort: medium
task_type: fix
area: codegen, runtime
language_feature: closures, classes
goal: self-hosting-dogfood
origin: "2026-06-22 dev-acorn — surfaced immediately after #2608 (new this construct via #56 bridge) let parse() advance past the empty-this.input loop."
related: [2608, 1940, 1712]
depends_on: [2608]
---

# #2628 — method call on a `__construct_closure`-constructed instance fails (5th acorn blocker)

## Context

#2608 fixed `new this(...)` in an fnctor static method by routing it through the
landed #56 `__construct_closure` host bridge. That unblocked the empty-`this.input`
loop — compiled-acorn `parse()` now advances PAST `parseTopLevel`'s empty-input
loop. The **next** wall, surfaced immediately, is acorn's exact `parse` shape:

```js
Parser.parse = function (input, options) {
  return new this(options, input).parse();
};
```

The `new this(options, input)` part now works (#2608), but the **`.parse()`
method call on the constructed instance** does not resolve.

## Symptom (minimal repro)

```ts
var Parser = function Parser(opts, input) {
  this.input = String(input);
};
Parser.prototype.getLen = function () {
  return this.input.length;
};

Parser.parseViaThis = function (input) {
  var p: any = new this({}, input);
  return p.getLen();
}; // THROWS "getLen is not a function"
Parser.parseViaIdent = function (input) {
  var p: any = new Parser({}, input);
  return p.getLen();
}; // OK → 5
```

- `viaIdent` (`new Parser(...).getLen()`) → **5** ✓ (identifier-constructed
  instance: prototype-method dispatch resolves).
- `viaThis` (`new this(...).getLen()`) → **THROWS `"getLen is not a function"`**.

## Root cause (suspected)

The `__construct_closure` bridge returns a **host-wrapped externref** — the result
of `Reflect.construct(_wrapCallableForHost(closure), args)`. A subsequent
prototype-method call (`p.getLen()`) on that value routes through the dynamic
method-dispatch path, which expects to find the method on the compiled
`Parser.prototype` / the WasmGC instance struct — but the bridge result is a JS
wrapper, not the raw `__fnctor_Parser` struct, so the method lookup misses.

By contrast, `new Parser(...)` returns the raw WasmGC struct directly (the
`<Class>_new` path), and prototype-method dispatch on it resolves through the
registered `__register_fnctor_instance` / `_fnctorProtoLookup` machinery (#1712).

## Suggested approach

Make the value returned by the `new this(...)` / `__construct_closure` bridge
arm participate in the SAME prototype-method dispatch as an identifier-constructed
fnctor instance. Either:

1. Have the bridge return (or have the `new this` arm unwrap to) the raw WasmGC
   instance struct so the existing fnctor prototype-method dispatch resolves it,
   or
2. Register the bridge-constructed instance with `__register_fnctor_instance`
   (the #1712 closure→prototype link) so a method miss on the host-wrapped value
   resolves through the closure's vivified `.prototype`.

Option 1 is preferable if the bridge can canonicalize back to the struct (the
WasmGC GC identity is preserved across the host boundary per
`project_wasm_linking_core_over_component`). The acceptance is `viaThis() === 5`
and, end-to-end, compiled-acorn `parse("var x = 1;")` returning a Program AST.

## Acceptance

- `new this(...).method()` resolves the prototype method (repro `viaThis` → 5).
- Compiled-acorn `parse("var x = 1;")` advances past the `new this(...).parse()`
  call (next dogfood lap — likely surfaces a 6th blocker; that's expected and
  recorded, per the #1711 triage discipline).
- No test262 / equivalence regression.

## Notes

This is **separate** from #2608 (which is purely `new this` constructing with
correct args — DONE and verified). #2628 is the method-dispatch-on-bridge-result
follow-on. Sequence after #2608 lands.

## Re-grounding (architect, 2026-06-22) — the IN-WASM acorn shape ALREADY WORKS

Faithful compile probes against current main contradict the "viaThis THROWS"
framing **for the acorn dogfood path**:

- `new this({}, input).getLen()` chained **IN-WASM** (the exact acorn
  `new this(options, input).parse()` shape) → **returns 5 ✓**. The
  `__construct_closure` trap's `self` IS registered for the in-wasm read path
  (`[protoHook]` fires for both `parse` and `getLen` via `_fnctorProtoLookup`),
  so `__extern_method_call` resolves the prototype method. **The acorn `parse()`
  dogfood lap is NOT blocked by #2628** — it advances past `new this(...).parse()`.
- The residual gap is **host-side only**: `Parser.makeViaThis(input)` returned to
  the JS harness, then `.getLen()` from JS → THROWS "getLen is not a function".
  The bridge result handed to host JS is a plain `Object`
  (`constructor.name === "Object"`) with no prototype link — the construct trap
  builds a bare `self = {}` (`runtime.ts:4904-4918`) and never links it via
  `_fnctorInstanceCtor` or sets its `[[Prototype]]`.

**Disposition:** the host-side residual is folded into **#2623 slice 2623-B**
(`__construct_closure` host-side instance identity + species — `Object.create(proto)`
+ `_fnctorInstanceCtor.set`), which also closes the `ctx-ctor` species rows. Do
NOT dispatch #2628 as a standalone acorn blocker; the dogfood lap is unblocked,
and the host-facing identity fix rides #2623-B. Re-probe the next acorn wall
after #2623-B lands.

## Resolution (dev-acorn-construct, 2026-06-27) — the IN-WASM path WAS broken on current main

The 2026-06-22 re-grounding above is **STALE / refuted by a verify-first probe on
current `origin/main` (`d52cca0c9`)**. The exact in-wasm chained shape the note
claimed "returns 5 ✓" actually **throws**:

```
new this({}, input).getLen()  chained IN-WASM  →  THREW "getLen is not a function"
new Parser({}, input).getLen() chained IN-WASM  →  5 ✓
```

So #2628 was a real, live, in-wasm dispatch defect — exactly as the original
symptom stated. (The intervening sibling PRs must have moved the path since the
note was written; re-grounding must always re-probe current main, per
`feedback_reground_spec_against_current_main`.)

### Root cause
The `__construct_closure` host bridge constructs the instance in the
`_wrapCallableForHost` **`construct` trap** (`runtime.ts`), which built a **bare
`self = {}`** — no `[[Prototype]]` link to the constructor closure's vivified
prototype, and no `_fnctorInstanceCtor` registration. A subsequent `p.m()`
routes through `__extern_method_call`, where the native `wrappedObj[method]` read
misses (the bare object has only own data fields) and the only fallback branch
required `_isWasmStruct(obj)` — false for the plain bridge object — so it threw.
By contrast `new Parser(...)` returns the raw WasmGC struct via `<Class>_new`,
whose method dispatch resolves through the registered fnctor machinery (#1712).

### Fix (two edits, `src/runtime.ts`, JS-host glue only)
1. **`construct` trap**: build the instance with
   `Object.create(_getOrVivifyFnPrototype(closure))` and register it via
   `_fnctorInstanceCtor.set(self, closure)` (also link a body-returned distinct
   object). Mirrors the identifier-constructed instance's prototype link.
2. **`__extern_method_call`**: when the native method read misses, consult
   `_fnctorProtoLookup(obj, method)` (works for any registered instance, struct
   or plain object), wrap the raw-struct method value into a callable, and
   dispatch with the instance as `this`.

Standalone/`noJsHost` is unaffected — the #2608 `new this` arm and this bridge
are JS-host-only; the standalone path keeps its existing behavior.

### Test Results (`tests/issue-2628.test.ts`, all pass)
- `new this({}, "hello").getLen()` (acorn parse shape) → **5** ✓ (was: THREW)
- `new Parser({}, "hello").getLen()` (no regression) → **5** ✓
- method calling another prototype method via `this` (`twice → this.getLen()*2`) → **10** ✓

Adjacent regression sweep (all green): issue-1528-closure-construct, issue-1632a,
issue-2608-new-this-fnctor-static, issue-1712(+dynamic-dispatch),
issue-2637-b2-ctor-closure-registration, fn-constructor,
issue-2026-constructor-identity-any, issue-28-promise-executor-invocation,
issue-2623-promise-subclass-identity, issue-1772-capability-map-extend,
issue-2660-s2/s3, wrapper-constructors. The 2 `promise-combinators` "with
resolved values" failures are **pre-existing on `origin/main`** (verified on a
clean checkout) — `_toIterable(arr)` argument shape, unrelated to this change.
