---
id: 2564
title: "Private-field nested-class follow-ups: polymorphic method-return blockType (invalid wasm) + read-before-own-slot TypeError gap"
status: ready
sprint: Backlog
created: 2026-06-20
updated: 2026-06-20
priority: medium
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen
language_feature: class-private-fields
goal: correctness
depends_on: [2563]
---

## Context

Spun out of #2563 (which fixed the global-index-desync invalid-wasm in the
private-field brand-check read path). Two residual test262 failures under
`test/language/statements/class/elements/` remain, with **distinct** root
causes from #2563.

## Part A — `privatefieldset-typeerror-3.js` (INVALID wasm)

```js
class Outer {
  #x = 42;
  innerclass() {
    return class extends Outer {     // method returns a class expression
      f() { this.#x = 1; }
    }
  }
  value() { return this.#x; }
}
var outer = new Outer();
var Inner = outer.innerclass();      // polymorphic receiver (Outer | __anonClass_0)
var i = new Inner();
```

Under the full test262 harness wrap (where `outer`/`Inner`/`i` are hoisted to
module scope), `outer.innerclass()` is compiled as a **tag-based polymorphic
dispatch** (`struct.get __tag` == 1 → Outer impl, == 2 → derived impl). The
dispatch `if`'s result blockType is resolved to the **function-wrapper struct
type** `$func.0` (`(struct (field funcref))`) instead of the method's actual
return struct type (`__anonClass_0` / `Outer`). The arms produce
`(call $Outer_innerclass …)` → `(ref null $__anonClass_0)`, which does not
match `(ref null $func.0)` → binaryen/V8:
`type error in fallthru[0] (expected (ref null 13), got (ref null 16))` in
`test()`.

The minimal (non-hoisted) form compiles to valid wasm — the bug only fires when
the receiver is module-scoped and the polymorphic dispatch path is taken. Root
cause is the method-return-type resolution for a method whose declared/ inferred
return type is a **class expression** (a constructable function value), which is
landing on the closure/fn-wrapper struct type rather than the produced class
struct. Fix needs to resolve the dispatch result blockType from the callee's
real return struct (the lowest common supertype of the candidate impls'
returns), not from the fn-wrapper type.

Start points: the tag-dispatch `if`-result-type construction for a member call
whose receiver static type admits subclasses (search the call-expression
lowering in `src/codegen/index.ts` / `expressions.ts`), and how a method
returning a `ClassExpression` gets its return ValType.

## Part B — `privatefieldget-typeerror-1.js` / `privatefieldset-typeerror-1.js` (behavioral, NOT invalid wasm)

```js
class C {
  y = this.#x;        // read #x in a field initializer …
  #x;                 // … before #x's own slot is initialized
}
assert.throws(TypeError, function() { new C(); })   // must throw
```

Per ES2022 PrivateFieldGet/PrivateFieldSet step 4 (PrivateFieldFind returns
empty → TypeError): reading/writing a private field whose
`[[PrivateFieldValues]]` entry has not yet been added throws TypeError. js2wasm
currently returns 2 (the field reads as its default, no throw). The compiler
treats `this.#x` inside the declaring class body as brand-guaranteed and skips
the runtime check — correct for the steady state, but it misses the
field-initialization-order window where `#x`'s slot exists structurally (the
struct field is allocated) but is semantically "not yet added". A spec-accurate
fix likely needs an initialized-flag / definite-assignment model for private
slots during the field-initializer phase, or to detect the
read-before-declaration order statically and emit a throw.

## Acceptance

- `privatefieldset-typeerror-3.js` → valid wasm + pass.
- `privatefieldget-typeerror-1.js`, `privatefieldset-typeerror-1.js` → pass
  (throw TypeError).
- Broad class/private-field test262 sweep: zero new regressions.
