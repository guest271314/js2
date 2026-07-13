---
id: 2853
title: "compiled-acorn THROWS parsing its OWN source — two bisected constructs: division after a numeric literal (`1 / 2`) and ANY regex group `(…)`"
status: done
completed: 2026-07-04
assignee: ttraenkler/fable-2853
sprint: 71
priority: low
horizon: m
feasibility: hard
created: 2026-06-30
updated: 2026-07-13
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

## Implementation (2026-07-04, senior-dev fable-2853) — BOTH bugs fixed

### Bug A fix — nominal shape branding (`src/codegen/shape-brand.ts`)

The mechanism under the banked "reads resolve by offset" finding is **WasmGC
iso-recursive structural canonicalization**: field names do not exist in the
binary, so the engine merges `__anon_{startsExpr:i32}` and
`__fnctor_TT{beforeExpr:i32}` (identical layouts) into ONE runtime type —
proven directly with a 2-type module where `ref.test $b` answers 1 on an `$a`
instance. Every `ref.test`-keyed dispatch (`__sget_*`/`__sset_*` exports, the
inline member-get chains) therefore matched the wrong shape and read by offset.
The pre-existing #2009 `$shape` stamp covers only `__anon_*`-vs-`__anon_*`
collisions at the exported-accessor level; A's collision was anon-vs-FNCTOR
and also poisoned inline dispatch, so it slipped through.

**Fix**: a finalize pass (`brandCollidingShapeTypes`, wired into both the
single- and multi-module pipelines right before `markLeafStructsFinal`)
appends a trailing immutable `(ref null <chain>)` brand field to every
`__anon_*` / `__fnctor_*` bare struct whose shallow layout collides with any
other struct in the module. Chain: first branded shape references
`$__vec_base` (an OPEN `sub` struct — openness/finality is part of canonical
identity, so it can't equal any bare shape), each later one references the
previously branded shape; by induction all branded shapes become pairwise
canonically distinct. `struct.new` sites get a purely local patch (`ref.null
<target>` immediately before — the brand is the LAST field). No type-table
insertion, no index remap, all chain refs point backward (no new rec groups),
runs before dead-type elimination so DCE remaps/keeps the chain. Collision-free
modules are **byte-identical** (verified vs main). Deliberately does NOT brand
class structs (subtype field-prefix rule) and leaves the #2527 cross-module
runtime-ABI types (strings/vecs) canonical — a whole-module rec group would
have broken that ABI and nominalized func types (call_ref hazards).

### Bug B root cause — sidecar SHADOW of live struct fields (NOT a type-index issue)

Instrumented full-acorn trace (patched `eat`/`advance`/`raise`/group-path,
`.tmp/acorn-instr.mts`) showed: inside prototype methods `this.pos` advanced
correctly (0→1→2→3), but **every `state.pos` read through the pp$1 method
PARAMETER read a frozen 0, and every param-path write (`state.pos = start`)
was lost**. `/(a)/` then died in `regexp_pattern`'s V8-compat branch:
param-read pos(0) ≠ len(3) → `state.eat(')')` succeeded against the TRUE
pos 2 → `raise "Unmatched ')'"`. (`/a/` passes that same broken comparison
only because its error branch finds nothing to eat — the defect was global,
not group-specific.)

Cause chain: `_emitStructFieldSettersInner` **skipped mixed-kind field-name
buckets** ("sidecar carries the write"), and acorn's `pos` bucket mixes kinds
across structs → `__sset_pos` was never emitted → host-MOP writes
(`__extern_set` → `_safeSet`) landed **sidecar-only**, while compiled
`struct.set` writes (`this.pos` in `advance()`) updated only the live field.
`__extern_get` consults the sidecar (`_safeGet`) BEFORE the `__sget_*`
getters, so once `regexp_pattern`'s `state.pos = 0` seeded the sidecar, every
param-path read saw the frozen 0 forever. Two divergent stores for one key.

**Fix** (two halves, `src/codegen/index.ts` + `src/runtime.ts`):

1. Mixed-kind buckets now emit `__sset_<key>` with the externref signature and
   per-arm coercion (numeric fields unbox via `__unbox_number`, `i32` fields
   truncate; un-coercible arms i64/f32/v128/packed are dropped and still fall
   back to the sidecar). All setters now return **i32 1 iff a dispatch arm
   matched and wrote the live field**.
2. `_safeSet` uses that flag: a successful live-field write **skips the
   sidecar and deletes any stale sidecar entry** for the key (except #2731
   shadowed re-added fields, which deliberately live in the sidecar). Old
   void setters return undefined → flag false → prior behaviour, so the
   runtime stays compatible with older binaries.

### Verification

- 4-line repro: `({startsExpr:true}).beforeExpr` no longer `true`;
  `new TT({startsExpr:true}).beforeExpr` falsy; positive controls intact.
- acorn probes: `1 / 2`, `10 / 2 / 5`, `a / b`, `a % b`, `/(a)/`, `/(?:a)/`,
  `/(?<n>a)/`, `/^in(stanceof)?$/`, `/a/`, `/[a-z]/` — **all parse**. AST
  `end` offsets are now correct too (previously stale 0 via the same shadow).
- `tests/issue-2853.test.ts` covers the aliasing + tokenizer-truthiness cases.

### Residuals (documented, out of scope here)

- Absent-key reads through a TYPED inline dispatch still coerce to `0`
  (number-typed fallback) instead of `undefined`, and the host `__sget` miss
  arm surfaces `null` rather than `undefined` — pre-existing typed-read/
  boxing residuals, truthiness-correct for acorn.
- Sibling CLASS structs with identical layouts can still canonicalize
  together (unbrandable without breaking subtype field prefixes) — same
  disease #2188 hand-fixed for Error subclasses; needs its own issue if it
  bites.
- `wasm-opt -O` type merging could in principle re-merge branded shapes
  (#2514 risk #2); `-O` is opt-in and not used by CI/test262.
- #2850 should now be closed into this issue: its char-class half was already
  fixed; its group half is fixed here (PO to reconcile).
