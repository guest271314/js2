---
id: 1679
title: "Stress test: compile acorn.js — `new this(...)` dynamic constructor unsupported"
status: done
created: 2026-05-27
updated: 2026-05-27
completed: 2026-05-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: new-expression, constructors, this
goal: real-world-compat
sprint: Backlog
related: [1519, 1609]
---
# #1679 — Compile acorn.js: `new this(...)` dynamic constructor unsupported

## Problem

Stress-testing the compiler against [acorn](https://github.com/acornjs/acorn)
(a popular ~6.3k-line pure-JS parser, MIT, no native deps) surfaces a single
distinct codegen gap that blocks the whole module.

`compile(acornSource)` on the **ESM build** (`acorn.mjs`, 6,266 lines) returns
with **6 errors, all one category**:

```
Unsupported new expression for class: Parser   (acorn.mjs:672:10 + 5 more)
```

The 6 reports collapse to **3 source sites**, all the same construct —
`new this(...)`:

```js
// acorn.mjs:671-683 — static factories on the Parser "class"
Parser.parse = function parse (input, options) {
  return new this(options, input).parse()          // :672
};
Parser.parseExpressionAt = function (input, pos, options) {
  var parser = new this(options, input, pos);       // :676
  parser.nextToken();
  return parser.parseExpression()
};
Parser.tokenizer = function tokenizer (input, options) {
  return new this(options, input)                   // :682
};
```

This is acorn's standard subclass-friendly static-factory idiom: `this` inside
a static method is the constructor (or a subclass thereof when `extend()`-ed),
and `new this(...)` instantiates the most-derived class. Per ECMA-262 §13.3.5
(`NewExpression` → `EvaluateNew`), the callee is the value of `this`, which is
a constructor; the compiler must construct it dynamically.

The remaining 471 diagnostics are **warnings**, not blockers — overwhelmingly
TS `Property 'X' does not exist on type 'Y'` (464×) because acorn is untyped
JS fed through the TS checker. They do not stop codegen (`success` flips on the
6 errors only). They are out of scope for this issue.

### What works / what doesn't

| input | result |
|-------|--------|
| `acorn.mjs` (ESM, no wrapper) | `success=true`, 6 errors (this issue), binary emitted | 
| `acorn.js` (UMD) | `success=false`, 2 errors — both from the UMD wrapper's `module` / `globalThis` (`Cannot find name 'module'`; `globalThis` union not assignable). Pre-existing module-format limitation, not codegen. Use the ESM build to exercise codegen. |

So acorn is **one construct away** from compiling: `new this(...)`.

## Root cause

`src/codegen/expressions/new-super.ts`:

- Line **2004**: `className = symbol?.name`. For `new this(...)` the TS checker
  resolves the `this`-type to the enclosing constructor's symbol, so
  `className = "Parser"` — which is why the error *names* `Parser`.
- The class-construct fast paths that would route to `Parser_new` are gated
  behind `ts.isIdentifier(expr.expression)` (lines **2015**, **2048**) and the
  `ctx.classSet.has(className)` block (line **2290**). `new this(...)` has a
  `ThisExpression` callee, not an identifier, so **every** typed branch is
  skipped and control falls through to the catch-all:
- Line **2831**: `reportError(ctx, expr, \`Unsupported new expression for class: ${className}\`)`.

The earlier non-identifier handling (lines 1320–1347) only covers
*non-constructor* callees (prototype methods, builtins → throw TypeError); it
has no path for a `this`-callee that IS a constructor.

Note: a bare `new this(x)` inside an ES6 `static` method, in isolation,
currently **compiles** (verified — `.tmp/repro-new-this.mts` returns
`success=true`). The acorn failure requires the full class-promotion context
(acorn builds `Parser` as a function-style class with
`Object.defineProperties(Parser.prototype, …)` + `Parser.prototype.X = …`),
which promotes `Parser` into `ctx.classSet` and routes the `new this` through
the className-resolved path above. The minimal in-repo reproducer is therefore
acorn itself; isolating a 10-line repro that triggers the same promotion is
part of the implementation work.

## Acceptance criteria

1. `new this(...)` where `this` resolves (via the checker) to a class in
   `ctx.classSet` constructs that class — emit the `<Class>_new` call path
   (same as `new <Class>(...)`), threading the actual arguments.
2. `compile(acornSource)` on `acorn.mjs` drops the 6 `Unsupported new
   expression for class: Parser` errors to 0 (warnings may remain).
3. A focused equivalence test covering the static-factory-via-`new this`
   pattern (function-style class promoted to `classSet`) compiles and runs.
4. No regression in the existing `new`-expression test262 buckets.

## Reproduction

```bash
cd /workspace/.tmp
curl -sL https://unpkg.com/acorn/dist/acorn.mjs -o acorn.mjs
# probe (see .tmp/compile-acorn.mts in the investigation): categorizes errors
npx tsx .tmp/compile-acorn.mts
# → success=true, errors=6 (all "Unsupported new expression for class: Parser")
```

## Notes / scope

- Out of scope: the 464 TS `Property does not exist` warnings (untyped-JS
  noise), the UMD-wrapper `module`/`globalThis` errors (module-format gap), and
  full runtime equivalence vs. real acorn output (this issue targets *codegen
  acceptance*, i.e. the module compiles without the `new this` blocker).
- Related: #1519 (other `new`-expression edge cases — spread, non-constructor
  TypeError, new.target), #1609 (non-literal spread in `new`). This is a
  distinct construct (constructor-via-`this`), not covered by either.

