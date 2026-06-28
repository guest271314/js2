---
id: 2794
title: "[SENIOR-DEV ONLY] acorn parse() residual: var-decl + binary-expression THROW (raise/unexpected) — distinct from the S3 vec-identity class; closes #2681/#2686"
status: in-progress
assignee: ttraenkler/sendev-acorn
sprint: current
priority: high
horizon: l
feasibility: hard
reasoning_effort: high
created: 2026-06-28
updated: 2026-06-28
task_type: bugfix
area: codegen
language_feature: value-representation
goal: acorn-dogfood
related: [2773, 2681, 2686, 2784, 2664, 2674]
depends_on: [2784]
blocks: [2681, 2686]
---

# #2794 — acorn `parse()` residual: var-decl + binary-expression THROW

**The last acorn-parse wall.** S1 (typeIdx) → S2/S2b (#2247, `new this()` reconstruct
+ dispatch symmetry) → S3 (#2784, native-vec dispatch) got compiled acorn parsing
**identifiers and call expressions** end-to-end. This issue closes the residual that
keeps **#2681** (var-decl) and **#2686** (binary-expression) from their full
acceptance.

## Current state on the S3 branch (issue-2784-s3-native-vec-dispatch / PR #2260)

Compiled acorn (gc/host mode, `compile(..., { skipSemanticDiagnostics: true })`):

| input | result |
|---|---|
| `parse("")` | OK — `Program` bodyLen 0 |
| `parse("1")` / `parse("1;")` | OK — `ExpressionStatement` / `Literal` |
| **`parse("x")`** | **OK — `ExpressionStatement` / `Identifier`** (#2681 hang GONE) |
| **`parse("foo(bar, baz);")`** | **OK — `ExpressionStatement` / `CallExpression`** |
| `parse("var x = 1;")` | **THROWS** `WebAssembly.Exception` (empty message) |
| `parse("1 + 2 * 3;")` | **THROWS** `WebAssembly.Exception` (#2686) |

So once S3 (#2784) merges, the remaining failures are the **var-declaration** and
**binary-expression** inputs. Both **THROW**, they do not hang.

## What is RULED OUT (do not re-investigate)

- **NOT the vec-identity / host-array storage split** (that was S3, #2784 — closed).
  The `scopeStack.push`/`[i]` round-trip is fixed; `currentVarScope()` terminates;
  `parse("x")` and the call path work. The residual is downstream of that.
- **NOT a hang.** Confirmed with the watchdog probe: `1 + 2 * 3;` returns a fast
  `THREW Exception`, not a `__extern_get` infinite loop. So it is a `raise()` /
  `unexpected()` throw on a token the parser should accept — the SAME *symptom class*
  the original #2681 had (`unexpected()` on a valid token), but in the
  operator-precedence / variable-declaration parse path rather than the identifier
  expression-statement path.
- **NOT a typeIdx desync** (S1 made fnctor typeIdx pass-invariant; ruled out earlier).

## The likely mechanism (verify-first, do NOT assume)

Mirrors the #2681 root cause one path over: a `this.<field>` / token-type comparison
in the **operator** path (`parseExprOp` / `parseExprOps` / `parseMaybeUnary`) and the
**variable-declaration** path (`parseVar` / `parseVarStatement` →
`parseBindingAtom` / `parseVarId`) reads a value whose identity DIVERGES from the
stored native `__fnctor_TokenType` / keyword struct, so a `switch`/`===` token-type
check falls to `default → unexpected()` → throw. Candidate divergence sources to
pin (instrument, don't guess):

- another native-struct value crossing a host boundary the S3 vec fix didn't cover
  (e.g. a `this.<field>` that is a `Map`/object, not a vec — `this.keywords`,
  `this.context` (the `TokContext[]` stack — IS a vec, should be S3-covered, verify),
  `DestructuringErrors`, the `types$1.<op>` `TokenType` operator tables read in
  `parseExprOp`);
- a keyword/operator `TokenType` comparison (`this.type === types$1.eq` /
  `types$1.plusMin` / `types$1.star` / `types$1._var`) where one operand is a
  re-proxied host externref (same divergence class as #2681, different field);
- the `parseVarStatement` path's `this.eat(types$1._var)` / `this.expect(...)`
  token-type check.

## Method (reuse the banked toolchain — all under `.tmp/`)

The S3 branch worktree `/workspace/.claude/worktrees/agent-a1ec1716299a8d4f2/.tmp/`
(and sr-acorn's `/workspace/.claude/worktrees/agent-ae75b7409d6e143f8/.tmp/`) hold
the reusable probes. **Acorn compiles in ~40s on this box — reuse ONE compile per
probe; the runner forks a worker with a per-input watchdog.**

- **`.tmp/acorn-run.mjs`** — single-compile worker-thread driver with a per-input
  watchdog + host-call-signature dump on hang. Drive with
  `INPUTS='["var x = 1;","1 + 2 * 3;"]' WATCHDOG_MS=20000 npx tsx .tmp/acorn-run.mjs`.
  Already confirms both THROW.
- **`.tmp/acorn-binkeys.mjs`** — compiles acorn once, instruments `__extern_get` to
  histogram the KEYS read per input (shows which `this.<field>` falls through to the
  host on the binary case vs the working identifier case). **This is the fastest way
  to pin the divergent field** — diff the key histogram of `"x"` (works) vs
  `"1 + 2 * 3;"` (throws). (It timed out at the 2-min tool cap doing a full
  acorn-compile + 2 parses — run it with a ≥5-min timeout.)
- **Raise-site instrumentation (the decisive probe):** patch acorn's
  `pp$9.raise` / `raiseRecoverable` / `unexpected` in the dogfood source
  (`tests/dogfood/.acorn` / `setup-acorn.mjs`) to log `this.type` (the token type)
  + `this.start` BEFORE the `throw`, exactly as the original #2681 analysis did
  (banked in the #2681 issue file's "## Localized (raise-site probe)" — it printed
  `UNEXPECTED @undefined type=name` for the identifier case). Do the same for
  `var x = 1;` / `1 + 2 * 3;` to name the exact token + call-site that mis-throws.
  Then numeric-coded `__n(code,val)` source instrumentation (avoid mixed-type `+`
  concat which garbles) to trace which `parseExprOp` / `parseVar` comparison fails.

- **Minimal-repro first:** before instrumenting full acorn, reproduce the divergence
  in a minimal fnctor that mirrors the failing shape (a lifted method doing
  `this.type === someTokenStruct` in an operator-precedence-style loop, or a
  `this.eat(kwStruct)` var-decl check) — far faster to iterate than 40s acorn
  compiles. The S3 `.tmp/s3-repro.mjs` and the identity repros are templates.

## Acceptance

- Compiled-acorn `parse("var x = 1;")` → a `VariableDeclaration` `Program`;
  `parse("1 + 2 * 3;")` → an `ExpressionStatement` whose `expression` is a
  `BinaryExpression` (operator precedence: `1 + (2 * 3)`).
- A dogfood guard test (`tests/dogfood/`) so "acorn parses var-decl + binary-expr"
  stays green.
- Set **#2681 AND #2686 AND #2794** `status: done`.
- Full `merge_group` + standalone-floor (broad-impact, codegen-adjacent).

## Build-on

- Depends on **#2784 (S3, PR #2260)** — branch from `origin/main` AFTER #2260 lands
  (it brings the native-vec dispatch the working identifier/call path relies on).
- The #2674 `__get_member_<name>` / #2664 `__set_member_<name>` finalize-filled
  dispatchers and the S2/S2b pinned read/write paths are the substrate the fix
  builds on — the residual is a value/field that still escapes them.

## Root-cause analysis (sendev-acorn, 2026-06-28) — branch `issue-2794-acorn-vardecl-binexpr`

**The residual is NOT one bug — it is a cluster of THREE distinct host-proxy /
marshaling gaps.** All three share the same *upstream* cause: acorn's Parser /
TokenType / AST-Node data is **`any`/externref-typed** (acorn is prototype-based
`function X(){}; pp.m = function(){}` with dynamic property access), so every
`this.<field>` / `node.<field>` access during a compiled-wasm parse routes
through the JS **host proxy** (`_wrapForHost` / `__extern_get` /
`__extern_method_call` / `__sget_<field>` in `src/runtime.ts`). Each *value
shape* that crosses must be presented faithfully (vec→array, node→object,
closure→bridge). The S3 fix (#2784) handled the vec case (`__is_vec` guard); the
three residuals below are more of the same class.

Method used (all confirmed empirically; probes banked in the branch `.tmp/`):
patched acorn's `raise()` to log its message before throwing, then narrowed with
field-level `console.log` instrumentation and a minimal `new TokenType(...)`
repro. NB: source-level `console.log` PERTURBS method-lifting/`this`-threading
(adding one shifts the failure) — trust the *clean* raise-probe + the
`_resolveHostField`/`__extern_get` host-side `DBG2794` traces over injected logs.

### (1) var-declaration — AST Node masked as `closureBridge` [PRIMARY for #2681]

`parse("var x;")` threw `Binding rvalue` from `checkLValSimple` (acorn
`acorn.mjs:2371`). Root cause: `checkLValSimple` does `switch (expr.type)` over a
**string** field, but `expr` (= `decl.id`, the Identifier node) arrived as the
host **`closureBridge` FUNCTION** (`typeof expr === "function"`, `expr.type ===
undefined`, `expr.name === "closureBridge"`). The `_wrapForHost` get-handler
(`src/runtime.ts` ~5224-5308) wraps *any* non-vec wasm-struct field value as a
`closureBridge` whenever generic `__call_fn_N` exports exist — it never verifies
the value is actually a closure. So a plain DATA struct (AST Node) is misclassified.
`parse("x")` works only because identifiers fall to the `default` arm of every
`switch` (identity irrelevant); `checkLValSimple` is the FIRST site that needs a
string-`===` / case match to be TRUE.

**Attempted fix (REVERTED — regresses):** gating the bridge on
`__is_closure(val) === 1` (mirroring the `__is_vec` guard) DID fix the node case
(var-decl advanced past `checkLValSimple`), **but `__is_closure` FALSE-NEGATIVES
on genuine closures** (a plain `() => n+1` arrow field read `__is_closure === 0`,
so the guard wrongly diverted it to an object proxy → `box.fn is not a function`).
The comment at `index.ts:4848` warns of false-POSITIVES; this is the inverse.
So `__is_closure` is **not a reliable data-vs-closure discriminator** in either
direction. A correct fix needs EITHER (a) a reliable positive `__is_data_struct`
/ named-struct discriminator emitted in codegen (like `__is_vec`), OR (b) fixing
`collectClosureBaseWrapperTypeIdxs`/`__is_closure` to catch ALL closure types
(incl. capture-less arrow closures) so it can be the gate.

### (2) var-declaration — vec read-methods (`indexOf`) unhandled [blocks #2681 after (1)]

With (1) patched, `parse("var x;")` advanced to `declareName`
(`acorn.mjs:3802`) → `scope.lexical.indexOf(name)` → `TypeError: indexOf is not
a function`. `__extern_method_call` (`src/runtime.ts` ~9890) special-cases only
`push`/`pop` on a vec receiver (via `__vec_push`/`__vec_pop`, unwrapping the
proxy); **read methods (`indexOf`, `includes`, `slice`, `join`, …) are not
materialized**, so a vec read-method on a nested scope array fails. Pre-existing
gap, only *unlocked* by (1). Fix: in `__extern_method_call`, when the receiver is
a vec, materialize it (`_vecToArray`) and apply `Array.prototype[method]` for
read-only methods (broad-impact, hot path — needs full CI validation).

### (3) binary-expression — `__sget_binop` returns null for the TokenType shape [PRIMARY for #2686]

`parse("1+2;")` threw `Unexpected token (1:1)` (at the `+`). Root cause:
`parseExprOp` (`acorn.mjs:2776`) reads `prec = this.type.binop`; for `plusMin`
the host-proxy read of `binop` returns **undefined** (should be 9), so `prec ==
null`, the operator is never consumed, and `unexpected()` throws. ALL
`conf`-derived TokenType fields read wrong via the proxy (`binop=undefined
beforeExpr=false prefix=false startsExpr=false`) while `label` (a direct ctor
param) reads `"+/-"` correctly. **The value IS stored** — a minimal
`new TokenType(label, {binop:9,…})` repro reads `binop=9` BOTH wasm-internally
AND via the wrapExports proxy. The divergence is acorn-specific: in the live
parse `_resolveHostField` falls through to `__sget_binop(plusMin)` which returns
`null` (DBG-traced), and the `#1712` nullish-as-MISS heuristic then yields
`undefined`. I.e. the per-shape `__sget_binop` dispatcher does **not cover
plusMin's concrete struct shape** in the full module (while `__sget_start` covers
the Node shape and `__sget_label` resolves via an earlier path), AND the host
sidecar (`_wasmStructProps`) misses these module-init-time-constructed structs.
NOT reproducible in a small module — tied to acorn's large struct-type graph
(suspect layout-canonicalization / dispatcher-coverage in the `__sget_<field>`
emitter). This is the blocker for EVERY binary expression and is independent of
(1)/(2).

**Sharper pointer for the codegen fix (3):** `__sget_<field>` is emitted by
`_emitStructFieldGettersInner` (`src/codegen/index.ts:2240`). It builds a
`fieldMap: fieldName → [{structTypeIdx, fieldIdx, fieldType}]` from
`ctx.structFields`/`ctx.structMap`, picks a return mode (extern/f64/i32) per
bucket, and emits the getter as a `ref.test`-against-each-`structTypeIdx`
dispatch chain (fall-through → `ref.null.extern`). `__sget_binop(plusMin)`
returning **null (extern mode, fall-through)** means **plusMin's runtime struct
type is NOT matched by the `binop` dispatch chain** — i.e. the `structTypeIdx`
the dispatcher `ref.test`s against ≠ plusMin's actual runtime type. Most likely a
struct-type identity/coverage problem: either the TokenType type carrying `binop`
in `ctx.structFields` was **remapped/deduped by DCE** after the getter captured
its index (cf. `project_type_index_shift_and_deadelim` /
`reference_subview_type_idx_stability`), or acorn produced **multiple TokenType
struct shapes** and `binop` was only registered on one. Repro path: dump the
`binop` fieldMap entries + the post-DCE type index of plusMin's struct and
compare. (`label` works because it resolves via an earlier host path before
`__sget`; `start`/`end` work because the Node type IS covered — so the bug is
TokenType-type-coverage-specific, not a blanket `__sget` failure.)

### Status / recommendation

- **#2681 (var-decl)** root-caused: needs a reliable data-vs-closure
  discriminator (1) + vec read-method materialization (2).
- **#2686 (binary-expr)** root-caused: needs `__sget_<field>` per-shape
  dispatcher coverage (or sidecar population) for module-init-constructed structs
  (3).
- The clean, class-eliminating fix for all three is to **stop routing acorn's
  Parser/TokenType/Node data through the host proxy** — i.e. give them wasm-native
  struct types — but that is an architecture-level change beyond this issue.
- Escalated to tech lead (a 2nd and 3rd distinct residual surfaced; the
  closureBridge guard regressed genuine closures → reverted). Branch left clean
  (no source change); analysis + banked probes preserved.
