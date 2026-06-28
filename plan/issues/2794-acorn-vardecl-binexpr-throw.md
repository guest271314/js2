---
id: 2794
title: "[SENIOR-DEV ONLY] acorn parse() residual: var-decl + binary-expression THROW (raise/unexpected) — distinct from the S3 vec-identity class; closes #2681/#2686"
status: ready
assignee: ttraenkler/unassigned
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
