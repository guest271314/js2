---
id: 2837
title: "[SENIOR-DEV ONLY] compiled acorn throws on BLOCK-BODY arrow functions with params — `(a) => { … }` / `x => { … }` (round-4 acorn-dogfood wall, blocks full edge.js equality)"
status: ready
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
created: 2026-06-29
task_type: bugfix
area: codegen
language_feature: value-representation
goal: acorn-dogfood
related: [2836, 2831, 2806, 2809, 2379, 2151]
depends_on: [2836]
blocks: [1712]
architect_spec: needed
---

# #2837 — compiled acorn throws on block-body arrow functions with params

**Round-4 acorn-dogfood wall, exposed after #2836.** #2836 (host-shim
`__make_iterable`/`_convertIterableForHost` `__is_vec` gate) cleared the
arrow-param wall for **expression-body** arrows and, as a bonus, **default and
rest params** — those now parse on compiled acorn. The remaining wall blocking
full `edge.js` (module, 1190 nodes) structural equality is **block-body arrows**.

## Repro (freshly-compiled pinned acorn@8.16.0, AFTER #2836)

`instance.exports.parse(src, {ecmaVersion:2022,sourceType:"script"})`:

```
x => x                 -> OK    (expression-body, #2836)
(a,b) => a             -> OK    (#2836)
(a=1) => a             -> OK    (default param, fixed by #2836)
(...a) => a            -> OK    (rest param, fixed by #2836)
function f(a = 1) {}   -> OK    (default param, fixed by #2836)
function f(...a) {}    -> OK    (rest param, fixed by #2836)

x => { return x; }     -> THROW WebAssembly.Exception   (BLOCK-BODY arrow, 1 param)
(a) => { return a; }   -> THROW WebAssembly.Exception   (BLOCK-BODY arrow)
```

So the wall is **specifically the block-body (`=> { … }`) arrow when it has ≥1
param**. Zero-param block-body arrows (`() => { return 1; }`) and all
expression-body arrows parse. `edge.js` contains parameterized block-body arrows,
so this is what now blocks the full NM differential (`background.js` is already
at the #1712 bar after #2836).

## Likely area (NOT yet root-caused — needs the same WAT-grounded isolation)

acorn's `parseArrowExpression` → `parseFunctionBody` (acorn.mjs:3546) branches on
`isExpression = isArrowFunction && this.type !== braceL`:
- **expression body** (`isExpression` true) → `node.body = parseMaybeAssign()` —
  works (#2836).
- **block body** (`isExpression` false) → `this.enterScope`, `parseBlock`,
  **`this.checkParams(node, …)`** (acorn.mjs ~3585) which walks `node.params`
  through `checkLValSimple`/`checkLValPattern` / scope-declaration. The params
  list survived #2836; the divergence is most likely in the **block-body-only**
  `checkParams` / scope-binding path (a value-rep or dispatch divergence specific
  to that branch), not in `toAssignableList` (now correct).

Recommend reproducing on the issue branch, instrumenting `parseFunctionBody`'s
block branch + `checkParams`, and dumping the WAT for the divergent read/dispatch
(mirror the #2836 verify-first method: static-vs-dynamic WAT diff, pin the exact
field/op that reads wrong). It may be another host-shim/marshalling asymmetry
(like #2836) or a distinct value-rep gap.

## Acceptance

- `parse("x => { return x; }")`, `parse("(a) => { return a; }")`,
  `parse("(a,b) => { return a + b; }")` on compiled acorn return the correct AST
  (no `WebAssembly.Exception`), structurally equal to node-acorn.
- The real-world NM differential `edge.js` (module) compiled-acorn vs node-acorn
  is **structurally equal** modulo the documented quirks (null `sourceFile`,
  boolean-as-i32) — completes the #1712 bar started by #2831/#2836.
- 0-regression `merge_group` + standalone-floor (broad-impact ⇒ full CI).

## Pointers

- acorn: `parseFunctionBody` block branch acorn.mjs:3546, `checkParams` ~3585,
  `parseArrowExpression` 3524.
- Repro infra (round-3 branch `issue-arrowparam-toassignable` `.tmp/`):
  `r4-probe.mjs` (the table above), `arrow-instr*.mjs` (instrumentation harness to
  clone), `nm-diff.mjs` (full-file differential), the architect's
  `edge-bisect.mjs` (in `/workspace/.claude/worktrees/agent-acac33ff565981548/.tmp/`).
- Verified after #2836 on compiled acorn@8.16.0, 2026-06-29 (sendev round 3).
