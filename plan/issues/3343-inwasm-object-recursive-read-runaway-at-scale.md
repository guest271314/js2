---
id: 3343
title: "In-Wasm dynamic-$Object recursive read runs away at scale (spurious back-edge on ~60+-node ASTs)"
status: ready
created: 2026-07-17
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: bug
area: runtime, codegen
language_feature: object
goal: runtime-eval
parent: 2927
related: [2937, 3308, 2928]
depends_on: []
---

# #3343 — In-Wasm dynamic-`$Object` recursive read runs away at scale

Surfaced by the **E0 in-Wasm AST consumer probe (#3308)**. Filed for the
`$Object`-reader / substrate owner — **not** self-dispatched.

## Problem

A **full recursive walk** of a compiled-acorn AST performed **in-Wasm** (dynamic
`$Object` named-field reads, the exact path the #2928 bytecode emitter will use)
**runs away** once the parsed program is large enough (~60+ ESTree nodes). On an
acyclic tree of 62 nodes the walk exceeds a **1,000,000-visit budget** — an
impossible call count for a tree unless a field read returns a **spurious
back-edge** (a node that re-enters an already-walked subtree). Small single
constructs walk perfectly.

This is a **read-fidelity limit at scale**, distinct from — and invisible to —
the host-boundary marshalling path the #1712 corpus measures (which walks the
whole tree out **once** via `wrapExports`; #3308/audit re-measured 23/23 host
parity). It is a candidate residual of the **#2937 `$Object`-hash-poison**
family.

## Why it matters

The #2928 **bytecode emitter (E2)** consumes the AST by **recursively walking
every node in-Wasm**. If a 60-node function body's AST cannot be walked in-Wasm
without a spurious back-edge, the emitter cannot lower it. This gates E2 for any
non-trivial `new Function(<dynamic>)` / `eval` body. E0's arbitration
(#2841/#2851/#2852 all read intact in-Wasm on single constructs) is unaffected;
this is the **next** substrate gate after E0/E1.

## Established facts (all measured in-Wasm on compiled-acorn@8.16.0 ASTs, 2026-07-17)

Reproduce with `pnpm run dogfood:acorn-probe` (see `tests/dogfood/acorn-probe.mjs`),
or the standalone probes recorded in #3308. All walks are budget-guarded so
nothing hangs; a runaway reports `-99999`.

- **Single-construct walks are ±0 faithful** — 15/15 inputs (`x`, `x+y`,
  `(a,b,c)=>a+b+c`, `(a,b,c)`, `` `hi ${x} bye` ``, `f(a,b)`, `a.b.c`,
  `[1,2,3]`, `{a:1,b:2}`, `let z=5`, `if/else`, `while`, `for`, `function g(){…}`,
  `a?b:c`) match node-acorn exactly.
- **Direct/indexed reads are faithful at scale** — `body[i].expression.name`
  reads `a,b,c,d,e,f,g,h` correctly for 8 statements; `===` is object identity
  (distinct nodes distinct); `.length` correct; missing-field reads → `undefined`
  (no trap). So **isolated reads are fine**; only the **recursive walk** diverges.
- **The runaway is scale-triggered, not construct-triggered:**
  - `a;` → 3 ✓, `a; b;` → 5 ✓, … `a;…;f;` (6 stmts) → 13 ✓
  - each `corpus/loops.js` line parsed **alone** → correct (15/12/12/15/6/7)
  - full `corpus/loops.js` (6 lines, one parse, 62 nodes) → **runaway**, even
    with a walk reading only `{body, expression}`
  - 11/13 corpus script files runaway; 2 under-count (a `===`-identity
    visited-set terminates but under-counts, e.g. 15 vs 62) — so it is neither a
    garbage `.length` nor a broken `===`.
- **Not a parse bug** — compiled-acorn's in-Wasm `parse` of every corpus file
  (including `escapes-unicode.js`) returns a correct `body.length` in <40 ms; the
  divergence is purely in the recursive **read** of the produced `$Object` graph.

## Hypothesis (for the substrate owner)

Once many `$Object`s with dynamically-assigned string-keyed fields coexist, a
named-field read on some node returns a value belonging to a _different_ node
(slot/hash aliasing), producing a graph back-edge. Individual reads sampled by
path (`body[i].…`) don't hit the aliased slot; the exhaustive recursive walk
does. Likely a hash/slot-reuse interaction in the dynamic-`$Object` field store
(cf. #2937). Reproduce, then walk the field-store read path for the collision.

## Acceptance criteria

- [ ] Root-cause the spurious back-edge in the in-Wasm dynamic-`$Object` read
      path (identify the aliasing read: node type, field, collision condition).
- [ ] `pnpm run dogfood:acorn-probe` reports **`match`** (±0 node count) for the
      corpus script files currently marked `runaway`/`undercount` (≥ 10 of 13).
- [ ] A minimal regression test (multi-statement program, exhaustive recursive
      `$Object` walk terminates with the correct node count).
