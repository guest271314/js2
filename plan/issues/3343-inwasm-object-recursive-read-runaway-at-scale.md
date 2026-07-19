---
id: 3343
title: "In-Wasm dynamic-$Object recursive read runs away at scale (spurious back-edge on ~60+-node ASTs)"
status: done
completed: 2026-07-17
assignee: ttraenkler/senior-dev
sprint: 72
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
# (#3343) The fix is a ~1-line correctness change INSIDE compileForStatement's
# for-init loop-var binding — it is intrinsic to that function and cannot be
# relocated to a subsystem module. loops.ts sits at its god-file ceiling, so the
# fix + its explanatory comment cross it by a few lines. Justified allowance.
loc-budget-allow:
  - src/codegen/statements/loops.ts
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

- [x] Root-cause the spurious back-edge in the in-Wasm dynamic-`$Object` read
      path (identify the aliasing read: node type, field, collision condition).
      **Re-diagnosed** — the back-edge is NOT a `$Object` read: the reads are
      faithful. It is a loop-counter control-flow bug (see below).
- [x] `pnpm run dogfood:acorn-probe` reports **`match`** (±0 node count) for the
      corpus script files currently marked `runaway`/`undercount` — now **13/13
      match** (was 11 runaway / 2 undercount).
- [x] A minimal regression test (multi-statement program, exhaustive recursive
      walk terminates with the correct node count) — `tests/issue-3343.test.ts`.

## Root cause (RESOLVED 2026-07-17) — NOT a `$Object` read bug

The issue's "`$Object` hash/slot aliasing" hypothesis is **wrong**. The dynamic
reads are perfectly faithful (verified by wrapping the host `__extern_get` seam
and tracing every read on a walk of `loops.js`: 0 non-deterministic reads, no
back-edge in the object graph, `type` reads consistent). The runaway is a
**control-flow codegen bug**: the loop **counter** is corrupted, not the data.

**Mechanism** (proven by disassembling the acorn-compiled walker to WAT):

A block-scoped `for (let i = 0; i < len; i++)` loop counter is compiled to a
**shared module global** (`$__mod_i`) instead of a per-invocation Wasm local,
**whenever a same-named module-level variable exists**. Compiled-acorn has a
top-level `i` → global `$__mod_i`, so **every** function's `for (let i)` aliased
that one global. In a **recursive** walk, `w(node[i])` re-enters `w`, whose own
array loop reuses `$__mod_i`, clobbering the caller's counter. Nested length-1
arrays leave the global at `1`, so the outer loop reads `1` → `i++` → `2` →
re-reads `node[2]` **forever** (the runaway). Single-construct ASTs never recurse
through nested arrays, so the global is never clobbered mid-loop — which is why
`≤15`-node walks were `±0` faithful and only `~60+`-node trees ran away. The 2
"undercount" corpus files are the same bug where a `===`-visited-set walk
terminates (finite cyclic graph) but skips the re-entered nodes.

The WAT of the walker's array loop showed `global.set $__mod_i` for init/`i++`
and `call <w>` (the recursion) in the loop body — an unambiguous confirmation.

**Fix**: `src/codegen/statements/loops.ts` `compileForStatement` bound a for-head
declaration to `ctx.moduleGlobals.get(name)` whenever the name was not already a
function local. `let`/`const` for-head bindings are **not** hoisted into
`localMap` (only `var` is), so the existing `hasLocalShadow` guard (the #1745
`var` fix) missed them and the block-scoped counter grabbed the module global. A
`for (let/const i)` **always** creates a fresh lexical binding (ECMA-262 §14.7.4);
inside a function it must be a per-invocation local. The fix adds
`blockScopedInsideFunction = !isVar && fctx.name !== "__module_init"` and skips
the module-global path in that case. `var` is unchanged (function-hoist →
`hasLocalShadow`); module-top-level `let`/`const` (`__module_init`) is unchanged.
for-of / for-in loop vars already bind via `allocLocal` (never the global) and
were never affected. Modules without a function-`for(let X)` / module-global-`X`
name collision are byte-identical.

**Why this gated E2 (#2928)**: the bytecode emitter consumes the AST by
recursively walking every node in-Wasm — exactly the recursive `for (let i)`
array iteration that the shared global broke. With per-invocation locals, the
emitter's walk terminates correctly on any tree.

**Validation**: `dogfood:acorn-probe` 13/13 match; `tests/issue-3343.test.ts`
2/2; equivalence loop/closure/recursion subset 105/106 (the 1 failure is a
pre-existing stale-harness test, confirmed by reverting the change). Pre-existing
failures in `tests/i32-loop-inference.test.ts`, `tests/labeled-loops.test.ts`,
`tests/issue-790.test.ts` are stale minimal-import harnesses on `main` (identical
with the fix disabled) — out of scope.

## Implementation Plan (arch, 2026-07-17) — SUPERSEDED / DISPROVEN

> **Superseded 2026-07-17.** This pre-implementation spec assumed the runaway
> was a standalone `$Object` open-hash-map read bug (`__obj_find` /
> `__obj_grow` / externref-identity). Empirical root-causing **disproved every
> one of these hypotheses**: the probe runs in **host mode** (`__extern_get` is
> a JS import, not the native hash-map), the traced reads are **faithful** (0
> non-deterministic reads, no object-graph back-edge), and the actual defect is
> a **control-flow codegen bug** — a `for (let i)` loop counter aliasing a
> module global (see "## Root cause (RESOLVED)" above). Kept verbatim below as a
> record of the ruled-out hypotheses; do NOT act on it.

> **Leverage note.** With #3348 resolved as a harness artifact (not a
> regression), THIS is the real remaining substrate blocker on the
> interpreter-ladder critical path: E2 (#2928) recursively walks the AST
> in-Wasm via dynamic `$Object` reads, exactly the path that runs away here.
> Root-causing needs one CPU-heavy probe run (`dogfood:acorn-probe`, ~27 s
> acorn compile) — schedule for the next window, NOT the CPU-bound one.

### Fix locus — the standalone `$Object` open-hash-map

Dynamic named-field reads on a `$Object` go through the **Wasm-native
open-hash-map** in `src/codegen/object-runtime.ts` (host-free path; the
in-Wasm walker uses no host calls by construction — see
`acorn-probe.mjs:11–30`). The read wrapper is `__dyn_member_get`
(`src/codegen/dyn-read.ts:700–740`); the map internals are:

| Helper | Anchor (`object-runtime.ts`) | Role |
| --- | --- | --- |
| `__obj_hash` | emit ~`883`; FNV-1a body ~`790–840` | key → i32 hash (string = FNV-1a over code units; Symbol = identity id) |
| `__key_equals` | emit ~`961` | slot-key vs search-key equality (string = structural `__str_equals`; Symbol = id-compare) |
| `__obj_find` | emit ~`1148`; idx ~`1170` | **open-addressing probe** — the read's core lookup |
| `__obj_grow` (rehash) | ~`1661–1730` | double capacity, rehash live (non-tombstone) entries, preserve `$PropEntry.seq` |
| `$PropEntry.seq` / `$Object.nextSeq` | ~`397`/`431`/`1899`; field def ~`434` | insertion-order seq (preserved across rehash, #1837) |

String keys are content-compared by `__key_equals` (not id-compared — the
id-compare at `:801–803` is Symbol-only), so a **string-key hash collision is
benign** (open addressing + structural equality resolves it). That rules out
the naïve "two field names collide" theory — the back-edge is a **wrong-SLOT**
or **wrong-VALUE** return, not a wrong-key-hash.

### Ranked hypotheses (each maps to an anchor + a discriminating probe)

1. **`__obj_find` probe mis-terminates under tombstones/near-full load**
   (`~1148`). Open addressing that stops at the first tombstone instead of
   continuing, or wraps incorrectly near capacity, returns a neighbouring
   slot's `$PropEntry` → its value belongs to a different logical field →
   back-edge. Discriminator: the runaway is **scale-triggered**, and probe
   mis-termination worsens as tables fill — fits. Probe: instrument
   `__obj_find` to also return the probe length; a correct acyclic walk should
   never see a probe land on a mismatched-then-accepted key.
2. **`__obj_grow` rehash mis-slots or drops an entry** (`~1661–1730`). If any
   corpus node's prop table crosses `INITIAL_CAP` and rehashes, a rehash that
   double-inserts or skips an entry yields a stale/wrong read post-grow.
   Discriminator: check whether the runaway inputs contain any single node with
   more fields than `INITIAL_CAP` (ESTree nodes are small — this is the LESS
   likely arm unless `INITIAL_CAP` is tiny; confirm the constant). If no node
   exceeds cap, rehash is NOT on the path and this arm is out.
3. **Cross-object `$Object` externref identity aliasing** (the
   `extern.convert_any` / `any.convert_extern` wrap in `dyn-read.ts` +
   `object-runtime.ts:43–45`). The walker's visited-set uses `===` (object
   identity). The under-count cases (`15 vs 62`, AC bullet: "a ===-identity
   visited-set terminates but under-counts") mean **two logically-distinct
   nodes compared `===` equal** — a genuine identity alias, NOT a value alias.
   That points at the externref wrapping not being identity-stable at scale
   (the same `$Object` heap ref reused for two nodes, or `convert_extern`
   round-trips not preserving `ref.eq`). Discriminator: the under-count arm is
   this hypothesis; the runaway (`>1e6` visits) arm is hypothesis 1/2. **These
   may be two faces of the same bug OR two bugs** — the probe already separates
   them (runaway vs under-count); root-cause each independently.
4. **#2937 hash-poison residual** (`index.ts:5372–5623`,
   `property-access.ts:595`). A `{}` var poisoned as an `$Object`-hash-consumer
   evolves a checker type that skips struct registration. If a subset of acorn
   nodes are built through the poisoned path they may share a mis-registered
   layout. Lower likelihood (poison is about static reads null-derefing, not
   dynamic-read aliasing) but cheap to rule out via the poison-set log.

### Investigation slices

**Slice 0 (S) — instrumented repro (next-window, CPU-heavy).** Run
`pnpm run dogfood:acorn-probe`; capture which corpus files runaway vs
under-count. Then build a **minimal** `.tmp` repro: the smallest multi-node
program that reproduces (bisect `corpus/loops.js`'s 6 lines — the issue already
shows the full 6-line/62-node parse runs away but each line alone is fine, so
binary-search the line COUNT at which it flips). Deliverable: the minimal
node-count threshold + whether it manifests as runaway or under-count.

**Slice 1 (M) — localize the aliasing read.** With the minimal repro, add a
debug counter/return to `__obj_find` (probe length + accepted-slot key) OR to
the externref wrap (log `ref.eq` identity of successive node reads). Determine
whether the alias is at the **find/slot** level (hyp 1/2) or the **identity
wrap** level (hyp 3). This is the root-cause deliverable (AC bullet 1).

**Slice 2 (M) — fix + regression lock.** Fix the identified helper
(`__obj_find` probe / `__obj_grow` rehash / the identity wrap). Add a
**standalone** regression test (a multi-statement program compiled standalone,
exhaustively walked in-Wasm, asserting the exact node count) under
`tests/` — NOT gated behind `DOGFOOD_ACORN` (it must run in the per-PR sweep;
keep it small so it doesn't need an acorn compile — hand-build a `$Object`
graph of ~80 nodes via a compiled TS program, or use the smallest acorn input
from Slice 0 if a compile is unavoidable, gated).

### Guardrails

- This is the **standalone / no-JS-host** `$Object` path — validate with the
  **standalone HW floor** + full CI/merge_group (per
  `project_standalone_floor_only_on_merge_group`), since a hash-map fix touches
  every standalone object read.
- Any change to `__obj_find` / `__obj_grow` must preserve `$PropEntry.seq`
  insertion-order semantics (#1837) — `Object.keys` ordering regresses
  otherwise. Re-run the object-enumeration tests.
- Do NOT "fix" by widening the visited-set to structural equality in the
  walker — that masks a real substrate identity bug (hyp 3). The walker is
  correct; the substrate read must return faithful nodes/identity.

### Horizon / slice breakdown

- **Slice 0 (S)** — instrumented repro + minimal threshold (next-window).
- **Slice 1 (M)** — localize (find/slot vs identity-wrap).
- **Slice 2 (M)** — fix + standalone regression test.

Slices 1–2 are ≤M and dev-claimable once Slice 0 pins the minimal repro.
Because root-causing needs the (CPU-heavy) probe, queue **Slice 0** as the
single ready task now; 1–2 unlock from its output.
