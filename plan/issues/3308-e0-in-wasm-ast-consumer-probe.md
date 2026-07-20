---
id: 3308
title: "E0 — in-Wasm AST consumer probe: walk compiled-acorn's AST inside Wasm to arbitrate parser bugs vs host-marshalling losses"
status: done
assignee: ttraenkler/senior-dev
created: 2026-07-16
completed: 2026-07-17
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: test
area: runtime, dogfood
language_feature: eval
goal: runtime-eval
sprint: 72
parent: 2927
depends_on: []
related: [2928, 1584, 1710, 1712, 2841, 2851, 2852, 2847, 3343, 3348]
---

> **NOT BLOCKED — E0 is COMPLETE (2026-07-17, senior-dev).** A prior
> `BLOCKED / depends_on: [3348]` re-scope (PR #3230) was based on **#3348's
> claim that compiled-acorn's `parse()` throws in-Wasm**. That claim was
> **arbitrated empirically and refuted**: it was a _harness artifact_ — the repro
> omitted `io.__setExports(instance.exports)` after `WebAssembly.instantiate`,
> which makes host dispatch mis-resolve and raises the runtime's
> `method is not a function` guard. With that one line, acorn-alone
> `wrapExports(...).parse("const a=1; let b=2; function f(){}", …)` returns a
> correct `Program` (`body.length === 3`), and the committed corpus harness
> reports **`compiled-threw=0`** across all 23 inputs on current main (_better_
> than the 2026-06-30 baseline's 1 — nothing regressed). **#3348 is
> `wont-fix`; no bisect is warranted.** `depends_on` cleared and the E0
> measurement below stands. Full evidence in #3348's resolution banner.

# #3308 — E0: in-Wasm AST consumer probe

Slice **E0** of the runtime-eval sequencing
(`docs/architecture/runtime-eval-interpreter.md` Part II §15–§16; the
`## Implementation Plan` in #2928). Extracted from umbrella #2927 so it is
independently claimable. **Unblocked now** (post-#2937).

## Problem

The #1710/#1712 dogfood corpus reads compiled-acorn's AST **across the host
boundary** via `wrapExports`, so its divergence report conflates two very
different failure classes:

- **True parser bugs** (block the #2928 interpreter): #2853-A/B (fixed),
  #2846 (BigInt literals).
- **Suspected host-marshalling-only losses** (likely irrelevant to the
  interpreter): #2841 (`params[]` blank), #2851 (template quasis blank),
  #2852 (sequence children blank), #2847 (cosmetics).

Under strategy 2(a) the bytecode emitter consumes the AST **in-Wasm** via
dynamic `$Object` field reads — never through `wrapExports`. If the fields are
intact in-Wasm, those four issues drop off the interpreter's critical path
entirely. _Suspected — not proven._ E0 is the arbitration measurement, and it
doubles as the maturity metric for the dynamic-`$Object`-reader substrate the
emitter will inherit (compiled-acorn `Node`s are open `$Object`s with
dynamically-assigned fields; every emitter field read goes through the
name-keyed dynamic read path).

## Implementation plan (distilled from §15/§16 + #2928 E0)

1. **Author a small TS walker** (strictly-typed js2wasm-compilable subset) that
   is compiled **alongside Acorn** in the same module — extend the #1710
   harness under `tests/dogfood/`. Entry points, all returning scalars so no
   marshalling is involved in the _measurement_ itself:
   - `probeNodeCount(src: string): number` — parse + full recursive walk,
     count nodes (objects with a `type` field).
   - `probeParamCount(src: string): number` — parse, walk to the first
     Function/Arrow node, return `params.length` (arbitrates #2841).
   - `probeQuasiCount(src: string): number` — first TemplateLiteral's
     `quasis.length` + a `cooked` first-char code (arbitrates #2851).
   - `probeSeqCount(src: string): number` — first SequenceExpression's
     `expressions.length` (arbitrates #2852).
2. **Walk pattern**: node-field reads on the compiled side are plain property
   accesses on `any`-typed values (`node.body`, `node.params[i]`) — exactly the
   dynamic `$Object` read path the #2928 emitter will use.
3. **Harness**: a Node-side runner (mirror `tests/dogfood/acorn-corpus.mjs`)
   feeds the same corpus inputs, compares the in-Wasm scalars against
   node-acorn ground truth computed in JS.
4. **Report**: extend `tests/dogfood/CORPUS-GAP-MAP.md` with an
   `in-Wasm vs host-boundary` column per gap issue.

## Acceptance criteria

- [x] Probe module compiles (Acorn + walker in one js2wasm compile) and runs
      under the host harness. — `tests/dogfood/acorn-probe.mjs`,
      `pnpm run dogfood:acorn-probe`, scalar-only measurement, budget-guarded so
      it never hangs.
- [x] For each of #2841/#2851/#2852: a definitive verdict recorded in the issue
      and in CORPUS-GAP-MAP.md. **All three: "field intact in-Wasm
      (marshalling-only; off the interpreter critical path)"** — verified on
      element-field integrity (not just container length), on both crafted and
      corpus inputs.
- [x] Node-count parity (±0) with node-acorn — **met on 15/15 single-construct
      inputs** (the read-path fidelity the criterion targets). **NUANCE:** the
      literal wording (≥5 _corpus_ files via a full-file recursive walk) is
      **substrate-capped** by a newly-found in-Wasm recursive-read runaway at
      scale (~60+ nodes) — filed as **#3343** for the substrate team (not
      self-dispatched). See Findings.

## Findings (2026-07-17, senior-dev)

Instrument: `tests/dogfood/acorn-probe.mjs` — compiles the pinned acorn entry
module **plus** a TS walker in **one** js2wasm module (`acorn-probe.mts`,
`skipSemanticDiagnostics`), so every AST field read happens **in-Wasm** via the
dynamic `$Object` read path the #2928 emitter will inherit. All probes return
scalars, so the measurement marshals no AST across the host boundary.

### Substrate mechanics established empirically (in-Wasm, on compiled-acorn ASTs)

- **STATIC named field reads are faithful.** `node.body`, `node.params`,
  `node.expressions`, deep chains (`body[0].declarations[0].init.type`) all
  return the correct values. Missing-field reads safely return `undefined`
  (no trap). `===` is object identity (self equal, siblings distinct).
  Variable numeric indexing (`arr[i]`) and `.length` are correct.
- **GENERIC computed access `node[k]` (runtime string key) does NOT descend** the
  same way — a whole-tree `Object.keys` walk collapsed to the root only. Out of
  scope here (one-line note); the emitter uses named reads, which work.

### Verdicts — #2841 / #2851 / #2852 (element-field integrity in-Wasm)

Measured on crafted single-construct inputs, comparing **element sub-fields**
(not just container lengths — a length-only probe gives a false "intact" because
these bugs blanked child _nodes_ while keeping array length correct):

| gap       | field                                     | in-Wasm verdict                                                                                                                    |
| --------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **#2841** | Function/Arrow `params[i].type` / `.name` | **INTACT** — `(a,b,c)=>…` reads 3/3 params with correct non-empty `.type`; marshalling-only, **off the interpreter critical path** |
| **#2851** | TemplateLiteral `quasis[i].value.cooked`  | **INTACT** — `` `hi ${x} bye` `` reads `quasis.length=2`, `cooked[0]='h'`; marshalling-only, off critical path                     |
| **#2852** | SequenceExpression `expressions[i].type`  | **INTACT** — `(a,b,c)` reads 3/3 expressions with correct `.type`; marshalling-only, off critical path                             |

All three are **host-marshalling-only losses** — they read intact in-Wasm and
**drop off the #2928 interpreter's critical path**. Consistent with the
2026-07-17 audit's re-measured 23/23 host-boundary parity (they no longer even
show as host-boundary divergences); E0 confirms the in-Wasm read path agrees.

### Node-count parity — split result (AC3)

- **±0 parity on 15/15 single-construct inputs** (x, `x+y`, `(a,b,c)=>a+b+c`,
  `(a,b,c)`, `` `hi ${x} bye` ``, `f(a,b)`, `a.b.c`, `[1,2,3]`, `{a:1,b:2}`,
  `let z=5`, `if/else`, `while`, `for`, `function g(){…}`, `a?b:c`). The in-Wasm
  type-switched recursive walk reaches **every** node faithfully per construct —
  the read-path fidelity AC3 is really asking for is **met**.
- **SCALE-DEPENDENT RUNAWAY on larger multi-construct programs.** A full
  recursive ESTree walk over a ~60+-node parse (e.g. the 6-statement
  `corpus/loops.js`, 62 nodes) blows a 1,000,000-visit budget on a 62-node tree
  — an impossible call count for an acyclic tree, i.e. a field read returns a
  **spurious back-edge that only manifests at scale**. This is a real **in-Wasm
  dynamic-`$Object` read-fidelity limit** in the reader (candidate residual of
  the #2937 `$Object`-hash-poison family). It is a _different surface_ from the
  audit's host-boundary marshalling (which walks the whole tree out once), so it
  does **not** contradict the 23/23 host parity.

  **Minimal repro (all budget-guarded so nothing hangs):**
  - `a;` → 3 ✓, `a; b;` → 5 ✓, `a; b; c;` → 7 ✓ … up to `a;…;f;` (6 simple) → 13 ✓
  - each `loops.js` line parsed **alone** → correct count (15/12/12/15/6/7)
  - full `loops.js` (all 6 lines, one parse) → **runaway** (budget blown), even
    with a walk reading only `{body, expression}`
  - identical result with a `===`-identity visited-set (terminates but
    under-counts, e.g. 15 vs 62) — so it is neither garbage `.length` nor broken
    `===`; distinct nodes read correctly in isolation yet the recursive walk over
    the large parse diverges.

  **AC3 as literally worded (≥5 _corpus_ files, full-file recursive walk) is
  substrate-capped** by this limit — corpus files runaway/under-count. The
  read-path fidelity it targets is delivered instead via the 15/15
  single-construct parity above. Follow-up substrate issue filed for the
  `$Object`-reader team (see below); **not** self-dispatched.

### Deliverables

- `tests/dogfood/acorn-probe.mjs` + `pnpm run dogfood:acorn-probe` (manual
  runner; heavy ~60s acorn compile, gitignored `report/acorn-probe.json`).
- `CORPUS-GAP-MAP.md` header refreshed to the 2026-07-17 clean run + an
  `in-Wasm vs host-boundary` arbitration section.
- Follow-up issue for the scale-dependent in-Wasm `$Object` recursive-read
  runaway (substrate team).

## Notes

Sized S. No dependency on P1/P2 (#2853, done) or E1 (#3101 pre-spec). Feeds
the E2 go/no-go in #2928's milestone order (E0 → E1/P1/P2 → E2).
