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

### (3) binary-expression — init-time `new X(objLiteral)` mis-reads the ctor's object-literal param [PRIMARY for #2686]

`parse("1+2;")` threw `Unexpected token (1:1)` (at the `+`). Root cause:
`parseExprOp` (`acorn.mjs:2776`) reads `prec = this.type.binop`; for `plusMin`
this is **undefined** (should be 9), so `prec == null`, the `+` is never
consumed, and `unexpected()` throws. ALL `conf`-derived TokenType fields are
wrong (`binop=undefined beforeExpr=false prefix=false startsExpr=false`) while
`label` (a direct ctor param) is correct.

**Corrected root cause (the earlier `__sget`-dispatcher hypothesis was WRONG —
ruled out below).** This is NOT the host proxy and NOT `__sget`: the
**wasm-internal** read `types$1.plusMin.binop` is *also* undefined — the binop
slot genuinely holds `null`. The value was never stored: `this.binop =
conf.binop || null` read `conf.binop` as `undefined` at construction (proved by
storing `(conf.binop === void 0) ? -2 : (conf.binop||-1)` into a spare field and
reading it back = **-2**). The struct shape is correct (`__struct_field_names`
shows all 10 fields incl. `binop`); the conf object literal stores binop fine
when read directly; a plain (non-`new`) function reading `conf.binop` works.

**The decisive bisection (in-acorn, fresh-extract probes in `.tmp/`):** the
failure is **`new X({field: v})` evaluated at MODULE-INIT time**, in acorn's
module:

```js
function VI(label, conf){ this.label = label; this.zz = conf.zz || null; }
var x = new VI("a", { zz: 9 });        // MODULE TOP-LEVEL → x.zz === null   ✗ BUG
function mk(){ return new VI("b", { zz: 9 }); }
//  mk().zz === 9                       // RUNTIME (inside a fn) → correct    ✓
```

Confirmed in-acorn results: `new VI(...)` at top-level → `null`; the SAME ctor
called at runtime → `9`; plain-function `f({zz:9})` → `9`; the literal read at
its own call site (`litG.zz`) → `9`; inside an object-literal initializer
(`var t = { k: new VI("b",{zz:9}) }`, the exact `types$1` shape) → `null`. So a
constructor invoked during the module's top-level/init evaluation receives an
object-literal argument whose fields the ctor body then reads as `undefined`,
even though the identical ctor + identical literal work at runtime.

**Scale-dependent**: a *standalone* module with the same pattern (even with the
full acorn token table, helpers, ~33 init-time `new TokenType` calls, and ~10
extra distinct object-literal struct shapes) reads `binop=9` correctly. The bug
only manifests inside the full acorn module — so it is an interaction between
**init-time `new`-call argument lowering** and something at acorn's scale
(strong suspect: type-index remap/DCE of the conf object-literal struct type in
the giant top-level init function, cf. `project_type_index_shift_and_deadelim` —
the init-time `struct.new` for the literal and the ctor's `struct.get` end up
referencing divergent type indices, so the param arrives as a struct the ctor's
`conf.<field>` read can't see). Needs a focused codegen dig into how top-level
`new X(objLiteral)` threads the literal's struct type to the constructor param
under DCE/type-table pressure — NOT minimally reproducible standalone yet.

**Ruled out for (3)** (do not re-investigate): host proxy / `_wrapForHost`
(wasm-internal read is also null); `__sget_<field>` per-shape dispatcher
(`_emitStructFieldGettersInner`, index.ts:2240) — the slot genuinely holds null,
`__sget` faithfully returns it; `emitNullGuardedStructGet` /
`findAlternateStructsForField` (property-access.ts) — `conf.binop` never routes
through it (0 hits); `__extern_get` (never called for `binop`, even at init);
field-name collision (a unique field name `zzPrecedence` fails identically);
the empty `{}` void-0 default (giving it a binop-bearing shape doesn't help);
prototype-method / fnctor-ness (fails with and without); simple object-literal
struct-table scale (10+ extra shapes standalone still works).

### Status / recommendation

- **#2681 (var-decl)** root-caused: needs a reliable data-vs-closure
  discriminator (1) + vec read-method materialization (2). Both in the
  host-proxy/marshaling layer (`src/runtime.ts`).
- **#2686 (binary-expr)** root-caused to a precise, in-acorn-minimal trigger
  (3): init-time `new X(objLiteral)` field-read returns null at acorn's scale.
  This is a **core codegen** bug (top-level `new`-arg lowering / type-index
  threading), DISTINCT from the host-proxy layer and from the `__sget`
  dispatcher (both ruled out). It is NOT the native-typing rewrite. Next step is
  a focused codegen investigation: dump the type index of the init-time object
  literal's `struct.new` vs the type the ctor's `conf.<field>` `struct.get`
  casts to, in the full acorn module; suspect a DCE/dedup remap divergence.
  Strong architect-spec / dedicated-codegen-session candidate — the cheap
  bisection is exhausted (standalone won't repro; acorn-down bisection is
  ~40s/compile).
- Banked probes (fresh-extract drivers) under the branch `.tmp/`:
  `variants{,2,3}.mjs` (the init-vs-runtime bisection), `binop-ctor.mjs`
  (the `-2` void-0 proof), `tt2/tt3.mjs` (in-acorn clone), `scale-repro.ts`
  (standalone scale control), `acorn-run.mjs` (watchdog driver).
- Branch left clean (no source change; all instrumentation reverted). The
  closureBridge guard for (1) was reverted (regressed genuine closures).
