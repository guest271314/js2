---
id: 3033
title: "compiled-acorn THROWS parsing a KEYWORD used as a property name (`x.var`, `x.function`, `x.if`) — the next-deeper acorn self-parse blocker after #2853"
status: ready
sprint: current
priority: low
horizon: m
feasibility: hard
created: 2026-07-04
task_type: bugfix
area: codegen, runtime
language_feature: tokenizer, member-expressions
goal: acorn-dogfood
related: [2853, 1712, 2618]
umbrella: 1712
---

# #3033 — compiled-acorn throws on `<expr>.<keyword>` property names

Found by bisecting the full acorn.mjs self-parse after #2853 landed both fixes
(division-after-number + regex groups). The self-parse now runs ~61s deep and
throws at **top-level statement index 238** — the `Scope` fnctor:

```js
var Scope = function Scope(flags) {
  this.flags = flags;
  this.var = []; //  ← the trigger
  ...
};
```

## Minimal repros (compiled-acorn throws `WebAssembly.Exception`, node-acorn OK)

```js
x.var;        // THROWS
x.var = [];   // THROWS
x.function;   // THROWS
x.if;         // THROWS
x.foo = [];   // OK  ← non-keyword property fine
function S(f) { this.var = []; }                          // THROWS
var Scope = function Scope(flags) { this.flags = flags; } // OK (no keyword prop)
```

So the gap is precisely: **a reserved word used as a property name after `.`**.
acorn accepts these via `parseIdent(liberal=true)` — for a keyword token it
takes the name from `this.type.keyword` (a string field present only on
keyword TokenTypes) and calls `this.next()`. Candidate mechanisms to check
first (in root-cause order of likelihood, given the #2853 findings):

- `this.type.keyword` is read off heterogeneous TokenType conf shapes — an
  absent/`undefined` `keyword` field on non-keyword types vs a string on
  keyword types; the read path may still misbehave for STRING-typed fields
  the way `pos` did for numerics (check `__sget_keyword` / dispatch arms).
- `keywordTypes["var"]` map lookups in the tokenizer (`readWord` →
  `keywordTypes` object with keyword keys) — dynamic string-keyed reads off a
  compiled object literal with ~40 keyword keys.
- `parseIdent`'s `liberal` flag flow / `containsEsc` checks.

## Repro harness

Same as #2853: compile the pinned tarball
(`tests/dogfood/.acorn/package/dist/acorn.mjs`,
`compile(src, {fileName:"acorn.mjs", skipSemanticDiagnostics:true})` →
instantiate with `r.importObject` + `__setExports` → `wrapExports(...).parse(snippet)`).
Bisect/instrumentation recipes banked in #2853's issue file; the statement
bisector pattern is `.tmp/acorn-bisect.mts` (binary-search top-level statement
prefixes against the node-acorn oracle).

## Acceptance

- `x.var`, `x.function`, `x.if`, `this.var = []` parse to the correct
  MemberExpression/AssignmentExpression (no throw); `x.foo` regression-free.
- compiled-acorn self-parses acorn.mjs past statement 238 (or the next-deeper
  gap is isolated + filed).
- No test262 regression.
