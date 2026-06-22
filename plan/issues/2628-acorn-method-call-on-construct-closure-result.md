---
id: 2628
title: "compiled-acorn: method call on a __construct_closure-constructed instance fails (5th dogfood blocker)"
status: ready
sprint: Backlog
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
