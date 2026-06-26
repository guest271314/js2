---
id: 2686
title: "acorn parse() — binary-expression statement throws (parse(\"1 + 2 * 3;\") → WebAssembly.Exception)"
status: ready
assignee: ttraenkler/unassigned
sprint: 66
created: 2026-06-26
updated: 2026-06-26
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
