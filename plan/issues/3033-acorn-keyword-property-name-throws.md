---
id: 3033
title: "compiled-acorn THROWS parsing a KEYWORD used as a property name (`x.var`, `x.function`, `x.if`) — the next-deeper acorn self-parse blocker after #2853"
status: in-progress
assignee: ttraenkler/dev-3051c
loc-budget-allow:
  - src/codegen/index.ts
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

## Progress (fable-3084, 2026-07-10) — Bug 1 of 2 fixed: extern-class name hijack; Bug 2 isolated

The `x.var` throw decomposes into TWO stacked compiler bugs. This slice fixes
the first and precisely isolates the second (satisfying the "next-deeper gap
isolated + filed" acceptance arm; `x.var` itself still throws until Bug 2 lands).

**Bug 1 (FIXED) — `any`-receiver method calls hijacked by ambient extern
classes.** `tryExternClassMethodOnAny` (`src/codegen/expressions/calls-closures.ts`)
resolves an `any`-receiver method call by FIRST-NAME-MATCH over every registered
extern class (lib.dom.d.ts et al.). Minimal repro (from bisecting the acorn
failure): `p.check()` on a module-level fnctor instance compiled to a
**`FontFaceSet_check`** DOM import — the user's `P.prototype.check` never ran;
the call returned the import's boxed default (`false`). This is the same hijack
family as the historical one-off refusals (slice #1062, replace/replaceAll
#1712, forEach/some #3014, isPrototypeOf #2994), generalized: the fix collects
(per source file, cached) every member name the USER's own code defines as
function-valued — prototype-method assignments incl. the acorn `var pp =
Parser.prototype; pp.m = fn` alias form, function-valued property assignments,
object-literal methods, class methods — and REFUSES extern-class first-match
dispatch for those names. The call falls through to the generic dynamic
dispatch (runtime-identity-correct for user AND host receivers).
`tests/issue-3033.test.ts` (4 tests incl. a Map.get no-regression guard);
dogfood `acorn.test.ts` green; issue-1283/1712/1062/3014 guards green.

**Bug 2 (ISOLATED, still open — the remaining `x.var` blocker).** Inside
compiled acorn, `parseIdentNode`'s `this.type` reads **undefined** when read
into a LOCAL (`var ty = this.type`) or used in a CONDITION — while the SAME
expression assigned to a MODULE GLOBAL reads the correct TokenType
(`label=var`), and sibling fields (`this.value`, `this.pos`) read correctly in
all contexts. So `else if (this.type.keyword)` is falsy → `this.unexpected()`
→ the WebAssembly.Exception. Probes (patched-source, `.tmp/probe-3033-acorn*.mts`
recipes): finishToken's own write+readback correct; `keywords["var"]` map +
`.keyword`/truthiness correct; host-side `parser.type` also undefined
(`__sget_type` dispatch returns nothing for the Parser shape). Minimal
2-3-shape repros do NOT reproduce — the failure needs acorn's scale (dozens of
struct shapes carrying a `type` field with HETEROGENEOUS types: string on every
AST-Node shape vs TokenType-ref on Parser). Root likely in the per-name
`__sget_<field>`/member-read shape dispatch or the typed-receiver struct-slot
resolution under that heterogeneity (#2773 value-rep adjacent). NOT the
first-match property-get path (`compileExternPropertyGet` is typed-className
gated).

**Also observed (flagged to tech lead, NOT this issue):** two pre-existing
regressions on current upstream/main vs aaa14719 — `Iterator.{zip,zipKeyed}`
basic-longest/strict vacuous fails, and `tests/issue-1888` "propagates NaN"
(verified failing with this branch's changes stashed).

## Progress (dev-3051c, 2026-07-12) — Bug 2 decomposed into 2a (FIXED) + 2b (isolated)

fable-3084's "Bug 2" is itself TWO stacked defects. This slice fixes the general
codegen half (2a) and precisely re-localizes the remaining half (2b); `x.var`
still throws until 2b lands.

**Bug 2a (FIXED) — an `undefined`-typed local off a DYNAMIC receiver was given
a numeric (i32) slot, truncating the externref value on store.** Root-caused via
runtime instrumentation of compiled acorn:

- `__sget_type(parser)` returns the correct TokenType host-side; `this.type ? 1`
  is truthy and `this.type.keyword` reads `"var"` — so the READ works. The loss
  is on STORE: `globalThis.__G = this.type` reads the TokenType, but
  `var __L = this.type` reads `undefined` (verified: `SAME=false`,
  `local-typeof=undefined`).
- `localTypeForDeclaration` typed `__L` **i32** (`resolveWasmType(undefined)`),
  because the checker — unable to resolve the untyped `this` in the anonymous
  `pp$5.parseIdentNode` — types `this.type` as pure `undefined` (flags 32768).
  The dynamic read (`this` resolves externref → `__extern_get`) returns
  externref; storing it into the i32 slot coerced it to the undefined-sentinel.
- Fix: extend the SINGLE shared helper `varBindingNeedsExternrefForUndefined`
  (used by BOTH the var-hoister and the let/const declaration path, so slot
  types stay in lockstep — no parallel branch) with a second arm: a
  Property/Element-access initializer whose static type is purely
  `undefined`/`void` AND whose receiver resolves to externref gets an externref
  slot. Reuses `resolveWasmType` for the receiver check. Distinguished from the
  #1112 f64-sentinel case by the receiver's wasm type (a known-struct optional
  field resolves to `ref $struct`, not externref → arm does not fire). Verified
  regression-free: the highest-risk equivalence suites (delete-sentinel,
  logical-conditional-identity void→NaN, coercion-arithmetic-add,
  tdz-reference-error, null-dereference-guards) fail IDENTICALLY (23/66) with and
  without the change — a pre-existing local-env set, unchanged by the fix.

**Bug 2b (ISOLATED, still open — the remaining `x.var` blocker).** With 2a
fixed, `parseIdentNode` now correctly takes the keyword branch (`kw=var`, no
`unexpected()` from it), yet `x.var` still throws `raise(pos=2, "Unexpected
token")` via `pp$9.unexpected`. Traced: the tokenizer produces the `var` keyword
token correctly (`readWord` → `keywords["var"]`), and `parseSubscript` enters the
member branch (`type=var val=var`) and calls `parseIdent(true)`, but `parseIdent`
throws AFTER `parseIdentNode` returns the `"var"` Identifier — the throw is in the
`this.next(!!liberal)` / post-node flow. The exact culprit is a keyword-after-`.`
tokenizer-CONTEXT interaction (updateContext / exprAllowed), plausibly the same
family as #2853 Bug A's num/slash context defect (not yet confirmed shared).
Instrumentation is blocked by a codegen stack-balance bug on complex injected
probe expressions (`__closure_39: not enough arguments on the stack for
f64.convert_i32_s`) — the next slice should instrument via a minimal side-effect
sink or extract the `parseIdent`/`next` closures from the WAT. `.tmp/probe-3033-*`
recipes bank the reproduction. This is genuinely senior-depth (acorn-scale
tokenizer state), matching the issue's `feasibility: hard`.
