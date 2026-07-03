---
id: 2686
title: "[ARCH] acorn parse() — binary-expression statement throws (parse(\"1 + 2 * 3;\") → WebAssembly.Exception); same root as #2681 (Parser not reconstructed), substrate-scoped"
status: done
completed: 2026-06-29
assignee: ttraenkler/sendev-substrate
sprint: 69
created: 2026-06-26
updated: 2026-07-03
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: unknown
goal: acorn-dogfood
related: [1712, 2681, 2674, 2664, 2660]
depends_on: [2660]
origin: "Surfaced re-verifying the acorn dogfood after #2085 fixed the 9th-wall hang (sd-2674c, #2674). With parseExpression() now running, numeric/empty statements parse, but a binary-expression statement THROWS a WebAssembly.Exception — distinct from the #2681 identifier-`unexpected()` wall."
---

# #2686 — acorn `parse()`: binary-expression statement throws

> **Resolution (2026-06-29).** Resolved by the acorn Parser-reconstruction
> substrate chain (#2264/#2272/#2275/#2301) — same root as #2681. Verified on
> freshly-compiled pinned acorn@8.16.0 (`skipSemanticDiagnostics: true`):
> `parse("1 + 2 * 3;")` → `ExpressionStatement` (no throw), where it previously
> threw a `WebAssembly.Exception`. The `parseExprOp` operator-precedence path now
> runs end-to-end. (The remaining function/arrow-body wall is tracked under the
> still-open #1712.)

## Context (the acorn dogfood chain → #1712)

After PR #2085 fixed the 9th-wall HANG (#2674 — host method-call bridge arity
dispatch), re-verifying the compiled-acorn surface on the #2085-merged
`upstream/main` (sd-2674c, `.tmp/diff-probe.mjs`, differential vs node-acorn):

| input | result |
|---|---|
| `""`, `";"`, `"1"`, `"1;"`, `"true;"` | Program returned (with AST diffs — see #2687) |
| `"1 + 2 * 3;"` | **THROWS `WebAssembly.Exception`** (this issue) |
| `"x"`, `"var x = 1;"` | THROWS — `unexpected()` on `name` (#2681) |

So a numeric LITERAL expression statement returns a Program, but a BINARY
expression (`1 + 2 * 3`) throws. The throw is distinct from #2681's identifier
path (a `name` token reaching `unexpected()`).

## Suspected locus (verify-first — do NOT assume)

The binary-expression path runs `parseExprOp` (operator-precedence loop reading
`this.type.binop`) over `parseMaybeUnary` operands. Likely candidates:
- a `this.type.binop` read (token-type member read) that mis-resolves like the
  #2674/#2681 `this.<field>` / holder-member read family → wrong precedence /
  null op → a throw path; or
- an `unexpected()` / `raise` reached because an operator token-type comparison
  (`this.type === types$1.star` etc.) fails the same way the #2681 `name`
  comparison does (the JS-host `__host_eq` proxy mis-canonicalization at scale,
  banked in #2674).

Strongly related to #2681 — likely the SAME root (token-type comparison / proxy
read), just reached via the operator path. Confirm with the banked `.tmp` probes
(instrument `raise`/`unexpected`/`__host_eq` under the worker-thread watchdog,
single acorn compile ~290s — reuse one compile).

## Acceptance
- Localize (verify-first) why `parse("1 + 2 * 3;")` throws; fix it (or fold into
  #2681 if the same root).
- Compiled-acorn `parse("1 + 2 * 3;")` returns a BinaryExpression AST matching
  node-acorn.
- Full merge_group / test262 (codegen-adjacent).

## SAME ROOT AS #2681 — substrate-scoped (2026-06-28, dev-acorn)

Re-verified on current `origin/main` (#2201): `parse("1 + 2 * 3;")` still THROWS.
Confirmed SAME root cause as #2681 — see #2681's `## ROOT CAUSE SHARPENED +
SUPERSEDED` section for the full analysis. In short: acorn's `Parser` is NOT
reconstructed as a `__fnctor_Parser` struct on current main (no such struct exists
in the acorn WAT), because acorn only ever does `new this(...)` inside the static
`Parser.parse`/etc — never `new Parser()` — so the fnctor escape-gate never
classifies it. The parser instance stays a dynamic `$Object`, so `this.type` reads
via `__extern_get` lose the `__fnctor_TokenType` identity; the operator-precedence
path's token-type comparisons (`this.type === types$1.<op>` in `parseExprOp`) then
fail the same way the #2681 identifier switch does → `unexpected()`/throw.

Fix is one of the two substrate paths in #2681 (A: escape-gate reconstruct
`new this()` sites; B: `$Object` reader struct-value identity) — architect call,
NOT a quick dev slice. Re-tagged `[ARCH]`. Likely closes together with #2681.

## Update — S2/S2b landed (sendev-substrate, 2026-06-28); #2686 still OPEN pending S3

Path (A) is now implemented: S2b's `new this()` escape-gate reconstruct gives
`Parser` a `$__fnctor_Parser` struct (verified registered in the acorn WAT — was
absent), and S2's read/write dispatch symmetry routes its field access through the
`__get_member_<name>` / `__set_member_<name>` dispatchers on S1's pass-invariant
typeIdx. BUT `parse("1 + 2 * 3;")` still hangs (the same `currentVarScope()`/
`scope.flags` loop as #2681). The remaining cause is the value-rep / host-boundary
identity loss (**epic S3**), NOT a typeIdx desync (S1 fixed that). Full mechanism +
S3 fix direction: see #2681's `## S2/S2b landed on a MERGED S1` section and the
#2773 epic S3 spec. **Closes together with #2681 once S3 lands.**
