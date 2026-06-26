---
id: 2687
title: "acorn parse() — ExpressionStatement.expression is null (parsed Literal not attached to the statement node)"
status: ready
assignee: ttraenkler/unassigned
sprint: 66
created: 2026-06-26
updated: 2026-06-26
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: unknown
goal: acorn-dogfood
related: [1712, 2681, 2674, 2664, 2659, 2660]
depends_on: [2660]
origin: "Surfaced re-verifying the acorn dogfood after #2085 fixed the 9th-wall hang (sd-2674c, #2674). The numeric/empty statements that DO parse return an ExpressionStatement whose `.expression` is null — the parsed Literal is not attached to the statement node. CONFIRMED a real codegen defect (not a host-marshalling artifact) by a direct struct-walk."
---

# #2687 — acorn `parse()`: ExpressionStatement.expression is `null`

## Context (the acorn dogfood chain → #1712)

After PR #2085 fixed the 9th-wall HANG (#2674), the simple statements that DO
parse on compiled acorn return a structurally INCOMPLETE AST vs node-acorn.

## Confirmed defect (direct struct-walk, NOT a marshalling artifact)

A direct live-object struct-walk (sd-2674c, `.tmp/structwalk.mjs`, one acorn
compile) — accessing `stmt.expression` DIRECTLY, not via `JSON.stringify`:

```
"1;"  → program.type=Program bodyLen=1
        stmt: { type:"ExpressionStatement", start:0, end:2,
                loc:undefined, sourceFile:undefined, range:undefined,
                expression: null }                       ← the Literal is MISSING
        stmt.expression (direct) = null
        stmt ownKeys = [type,start,end,loc,sourceFile,range,expression]
"1"     → same: expression = null
"true;" → same: expression = null
";"     → EmptyStatement (no expression field) — CORRECT
```

The `expression` own-key IS present and directly readable, but its value is
genuinely `null`, while sibling string fields (`type="ExpressionStatement"`) read
correctly. So this is a **real codegen defect**, not a host-marshalling-depth
artifact: acorn's `parseExpressionStatement` does
`node.expression = expr; return this.finishNode(node, "ExpressionStatement")`, and
the `expression` child (the parsed `Literal`) is not attached to the freshly-built
Node.

(`loc`/`range`/`sourceFile` being `undefined` is benign — acorn only populates
loc/range when `locations`/`ranges` options are set; `sourceFile` is an internal
Node field. The only real divergence vs node-acorn is `expression: null`.)

## Suspected locus (verify-first — do NOT assume)

`parseExpressionStatement(node, expr)` → `node.expression = expr; finishNode(...)`.
The write `node.expression = expr` is to a freshly-`new Node()` struct. Candidates:
- the WRITE `node.expression = <Literal>` is dropped (the #2664 write-dispatch /
  multi-shape struct-slot family — `node` is a `Node` struct, the write may miss
  the slot or hit a sidecar that the later READ doesn't see); OR
- `parseExpression()`/`parseLiteral()` returns the Literal correctly but the
  assignment target `node` is a different representation than the one returned by
  `finishNode` (read/write representation divergence — same family as #2674).

Verify with the banked `.tmp` probes (instrument `__set_member`/`__extern_set` for
key `expression` on a Node receiver, single acorn compile ~290s). Likely the same
struct-slot write/read family as #2664/#2655/#2659 — possibly already addressed
for other fields by the #2664 `__set_member_<name>` dispatcher; re-probe to see if
`expression` specifically diverges.

## Acceptance
- Localize (verify-first) why `node.expression` is null on the returned
  ExpressionStatement; fix it.
- Compiled-acorn `parse("1;")` returns `ExpressionStatement{ expression:
  Literal{ value: 1 } }` matching node-acorn (the #1712 differential passes for
  literal expression statements).
- Full merge_group / test262 (codegen-adjacent).
