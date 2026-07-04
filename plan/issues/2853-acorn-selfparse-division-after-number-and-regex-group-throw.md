---
id: 2853
title: "compiled-acorn THROWS parsing its OWN source — two bisected constructs: division after a numeric literal (`1 / 2`) and ANY regex group `(…)`"
status: in-progress
assignee: ttraenkler/fable-2853
sprint: current
priority: low
horizon: m
feasibility: hard
created: 2026-06-30
updated: 2026-07-04
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

## Root cause — Bug A ISOLATED (2026-07-03, dev-team-a)

**Bug A is NOT a RegExp-validator bug and NOT tokenizer-specific — it is a
general codegen property-read aliasing bug, reduced to a 4-line non-acorn
repro.** The "instrument the validator" framing was a red herring: the validator
only *traps* because the tokenizer already mis-decided, and the tokenizer
mis-decided because a boolean property read returned the wrong field.

### Instrumentation evidence (patched acorn copy, current `upstream/main` e29c8c5b2)

Logging acorn's `updateContext` else-branch + `readToken_slash` while parsing
`var x = 1 / 2;`:

```
UC-else type=num beforeExpr=true -> exprAllowed=1     ← WRONG: num.beforeExpr must be FALSE
SLASH exprAllowed=1 prevType=num                       ← so '/' after a number is read as a REGEX start
THREW [object WebAssembly.Exception]                   ← malformed "regex" (the division) traps the validator
```

`num` is defined `new TokenType("num", startsExpr)` where
`startsExpr = {startsExpr: true}` (no `beforeExpr` key), and the ctor does
`this.beforeExpr = !!conf.beforeExpr`. Correct result: `num.beforeExpr === false`.
Compiled-acorn computes `true`.

### Minimal repro (no acorn — general codegen bug)

```ts
function TT(conf) { this.beforeExpr = !!conf.beforeExpr; }
export function fromStartsExpr() { return new TT({ startsExpr: true }).beforeExpr; } // === true, MUST be false
// and even more directly:
export function readAbsent() { var c = { startsExpr: true }; return c.beforeExpr; }  // === true, MUST be undefined
```

`{ startsExpr: true }.beforeExpr` returns **`true`** — it **aliases the sibling
field `startsExpr` at the same struct offset** instead of returning `undefined`.
Two single-key object literals `{startsExpr:true}` and `{beforeExpr:true}` compile
to structs whose field lands at the same offset, and the dynamic `.prop` read
resolves **by offset, not by key**, so reading a key the object doesn't have
returns whatever field sits at that offset. The manifestation is shape-dependent
(a variant `rd(c){return c.beforeExpr}` exported fn returns a wrong constant
instead), confirming a genuine dynamic/heterogeneous-shape property-read defect
rather than a one-off.

### Fix location + sizing

The dynamic property-read lowering must **verify the receiver's struct actually
has the named field before `struct.get`** (name-checked getter, e.g. the
`__sget_<key>` ref.test-per-struct-type path, or the object-literal shape typing
that currently lets two distinct single-key shapes collapse to one offset).
Codegen sites: `src/codegen/object-ops.ts` / `src/codegen/expressions.ts`
member-access + object-literal-shape lowering. This is a **general correctness
bug** with broad blast radius (every heterogeneous-shape property read) —
`feasibility: hard`, **senior-dev/architect scale**, must validate IN BATCH.
Not a bounded dev slice. Bug A's acceptance can't be met without fixing this
general read path; a `num`-token-specific hack would leave the underlying defect
(acorn reads `beforeExpr`/`startsExpr` off shared conf shapes in many places).

### Bug B (regex group `/(a)/`) — status: NOT yet root-caused here

Confirmed still throwing (`/(a)/`, `/(?:a)/`, `/(?<n>a)/` throw; `/a/`,
`/[a-z]/`, `/\d/` OK — so #2850's char-class half is indeed fixed). Whether B
shares this property-read root cause or is a separate validator/array defect is
**unverified** — re-check B against this root cause first (it may partly clear if
the group path reads an absent property off a heterogeneous shape). Repro harness:
`.tmp/repro2853.mts` pattern (compile pinned acorn once → parse snippets), and
`.tmp/acorn-instr.mjs` instrumentation recipe above.
