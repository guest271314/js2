---
id: 2853
title: "compiled-acorn THROWS parsing its OWN source — two bisected constructs: division after a numeric literal (`1 / 2`) and ANY regex group `(…)`"
status: ready
sprint: current
priority: low
horizon: m
feasibility: hard
created: 2026-06-30
updated: 2026-06-30
task_type: bugfix
area: codegen, runtime
language_feature: regexp, tokenizer
goal: acorn-dogfood
related: [1712, 1690, 2850]
umbrella: 1712
---

# #2853 — compiled-acorn throws self-parsing acorn.mjs: division-after-number + regex groups

The ultimate dogfood: feeding **acorn's own pinned entry module**
(`tests/dogfood/.acorn/.../dist/acorn.mjs`, acorn@8.16.0) to **compiled-acorn**
`parse()` throws a `WebAssembly.Exception` mid-parse, while node-acorn (same
pinned tarball = oracle) produces a valid AST. Bisecting acorn.mjs by top-level
statement and narrowing to minimal slices isolated **two distinct, fully
minimized root constructs** (verified post-#2325/#2838; full self-parse confirmed
throwing).

## Minimal repros (compiled-acorn throws, node-acorn OK)

### A. Division immediately after a numeric literal

```js
var x = 1 / 2; // THROWS    (node-acorn: BinaryExpression `/`)
var x = 10 / 2 / 5; // THROWS
var x = a / b; // OK         ← division after an *identifier* is fine
f(a / b); // OK
var x = a % b; // OK
var x = a * b; // OK
```

The trigger is **`<numericLiteral> / …`** specifically. Division after an
identifier (`a / b`) parses correctly, so this is **not** a general division
gap — it is a **tokenizer regex-vs-division context bug**: after reading a
**number** token, compiled-acorn leaves `exprAllowed` / the token-context state
wrong, so `readToken_slash` mis-tokenizes the following `/` as the **start of a
regex literal** instead of the division operator. It then scans a malformed
regex to EOF and the RegExp validator traps. (acorn.mjs is full of
`pos / something` arithmetic, so this fires repeatedly during self-parse.)

### B. Regex literal containing ANY group `( … )`

```js
var x = /(a)/; // THROWS     capturing group
var x = /(?:a)/; // THROWS   non-capturing group
var x = /(?<n>a)/; // THROWS  named capture group
var x = /^in(stanceof)?$/; // THROWS  (the first real thrower in acorn.mjs, line 38)
```

…but **these now PARSE fine** (so the gap is specifically the **group `(…)`**):

```js
/a/  /ab/  /a?/  /a+/  /a*/  /a|b/  /^a/  /a$/  /[a]/  /[a-z]/  /\d/   // all OK
```

> **NOTE — this REFINES / partly supersedes #2850.** #2850 ("regex char-class
> `[…]`/`\d` or named-group throws") is now **stale on the char-class half**:
> `/[a-z]/`, `/[a]/`, and `/\d/` all PARSE in compiled-acorn today (likely fixed
> by #1690-family work). The **only** remaining regex-validation throw is the
> **group `(…)`** (capturing, non-capturing, AND named — not just named). #2850
> should be re-scoped to "regex group `(…)` validation throws" or closed in
> favour of this issue's repro B. Flagging the tech lead/PO to reconcile.

## Likely shared root

Both classes funnel into acorn's `RegExpValidationState` /
`validateRegExpPattern` machinery — the same charCode-loop + global-lookup-array
code that exposed **#1690** (`isInAstralSet` global-array f64/i32 mismatch). The
group case (B) traps when the validator hits a `(` and tracks group
depth/capturing-group count in an array; the division case (A) feeds a malformed
pattern into the *same* validator via the tokenizer mis-decision. Pinning the
exact trap (the compiled `__exn` payload is an opaque un-exported externref → host
sees only `[object WebAssembly.Exception]`) requires instrumenting the validator,
but the two surface repros above are deterministic.

## Repro harness

```
# focused probe (compile pinned acorn once, then parse the snippets):
#   compile(acornSource, {fileName:"acorn.mjs", skipSemanticDiagnostics:true})
#   -> WebAssembly.instantiate -> __setExports -> wrapExports(...).parse(snippet)
#   -> diffAst vs node-acorn oracle (tests/dogfood/ast-diff.mjs)
# or the full corpus self-parse stressor once PR #2330 lands:
node --import tsx tests/dogfood/acorn-corpus.mjs   # acorn-self input -> compiled-parse-threw
```

## Acceptance

- `var x = 1 / 2;` and `var x = 10 / 2 / 5;` parse to the correct
  `BinaryExpression` (no throw); `a / b` regression-free.
- `/(a)/`, `/(?:a)/`, `/(?<n>a)/`, `/^in(stanceof)?$/` parse to a `Literal` with
  `regex:{pattern,flags}` (no throw).
- compiled-acorn self-parses acorn.mjs without throwing (or the next-deeper gap
  is isolated + filed).
- No test262 regression. Reconcile #2850 (char-class half already fixed).
