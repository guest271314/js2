---
id: 2135
title: "Single IR capability predicate shared by selector and builder (retire select.ts/from-ast.ts drift)"
status: in-progress
assignee: ttraenkler/dev-2138f
pipeline_unblocked: 1927
sprint: 67
created: 2026-06-12
updated: 2026-07-02
priority: high
feasibility: hard
reasoning_effort: max
model: fable
task_type: architecture
area: compiler
language_feature: compiler-internals
goal: correctness
related: [1923, 1804, 1922, 2138, 2945, 2947]
origin: "2026-06-12 sprint-62 architecture analysis (IR workstream N2)"
---

# #2135 — "what IR can do" is encoded twice; disagreement = silent demotion

## Problem

`select.ts` accepts shapes `from-ast.ts` throws on by design (e.g. array
literals: `select.ts:1704-1707` accepts, `from-ast.ts:1229` throws "not in
slice 12"). 174 `throw new Error` sites in from-ast.ts land in the warning
channel and are counted nowhere — the ratchet
(`scripts/ir-fallback-baseline.json`) only counts selector reasons, so a
post-claim regression bypasses CI entirely (#1923's finding, confirmed).

## Approach

Extract a `capability.ts` table (node kind × shape guard) consumed by both
`isPhase1Expr` (select.ts) and the from-ast dispatch; from-ast throws become
`unreachable` assertions where the table says claimable. Stage per
expression family. Architect spec first (Fable), staged impl follows.

## Acceptance criteria

- The array-literal intentional mismatch is gone (lands with #1804).
- Count of from-ast throw sites reachable post-claim drops measurably via
  #1923's meter.
- New IR features add one table row, not two predicates.

## Notes

Size L staged; spec is sprint-62, implementation can spill into 63 per
family. Depends on #1923 (metering) for the acceptance measurement.

### Cluster sequencing note (2026-06-23, architect)

Pipeline prerequisite **#1927 has landed** (PR #1958). This issue is best
sequenced **right after #2138 Slice 2** (the `JS2WASM_IR_FIRST` compile-once
inversion): under that flag a selector↔builder disagreement stops being a
silent legacy demote and becomes a hard trap on a skipped function, so the
`select.ts` ⇄ `from-ast.ts` capability drift this issue closes is exactly the
divergence #2138's measurement surfaces. #2138's `## Implementation Plan` records
the same dependency. Still parked on **#2167** (Fable disabled) for dispatch.

**2026-07-02 (dev-2138f): #2167 resolved (Fable re-enabled), #2138 Slice 2
landed (PR #2468). blocked_by cleared, status → in-progress.**

## Implementation Notes (dev-2138f, Fable, 2026-07-02 — Slice 1: operator family)

### What landed (slice 1)

`src/ir/capability.ts` — the single-source table, three states per row:

- **`claim`** — selector accepts AND builder lowers every shape-admitted
  operand. Type-level demotes (operand types the IR can't represent) remain
  owned by the type-resolution lane; they are not capability drift.
- **`claim-partial`** — TRANSITIONAL: selector accepts, builder lowers a
  documented subset and demotes the rest through the metered post-claim
  channel (#1923 / `irPostClaimErrors`). Every entry carries the tracking
  issue that retires it (→ `claim` by finishing the lowering, or → `defer`).
- **`defer`** — selector rejects up-front; the builder's guard becomes an
  internal-invariant assertion (`assertNotDeferred` — a defer construct
  arriving post-claim is a compiler BUG, loudly distinct from the
  `not in slice N` fallback family). Unknown constructs default to defer.

Consumers rewired: `select.ts` `isPhase1BinaryOp`/`isPhase1PrefixOp` are now
thin table reads (`capability !== "defer"`); `from-ast.ts` `lowerBinary` /
`lowerPrefixUnary` assert the same table on entry.

**Rows flipped in slice 1** — the deliberate slice-11 "shape-only acceptance"
over-claims (`%`, `**`, `in`, `instanceof`: selector accepted, builder threw
`not in slice 11`) are now `defer`. Observable effects:

- `irPostClaimErrors` for this family drops to ZERO (acceptance criterion 2
  — e.g. an `a % b` function used to produce a post-claim `build` error;
  now it is selector-rejected and compiles clean via legacy; probes in
  `tests/issue-2135.test.ts`).
- Under #2138's `JS2WASM_IR_FIRST=1` these ops can no longer hard-error
  (#2945's failure mode is structurally gone — #2945 remains open as the
  "implement `%` lowering, flip the row to claim" issue).
- `scripts/ir-fallback-baseline.json` refreshed: the two corpus functions in
  this family moved buckets (`call-graph-closure` −2 → `body-shape-rejected`
  +2; total unchanged) because they are now rejected at Step 1 instead of
  being claimed and then dropped by the Step-2 closure. Same final artifact
  (legacy body) — a reason relabel, not a coverage change.
- `??` and `+` stay `claim-partial` (`lowerNullish` reference-subset;
  #2781's `+` operand-type proof) — their residual demotes are the honest
  metered remainder, unchanged.

### Deliberate scope choices

1. **Operator family only.** The issue is staged per expression family; the
   operator family was slice 1 because it held the only *fully-unlowered*
   over-claims (the #2945 class — the ones that hard-error under IR-first).
   Follow-up families in rough value order: call shapes (external-call
   whitelist ⇄ `lowerCall` throw sites), element/property access arg shapes,
   array-literal shapes (the #1804 mismatch — re-verify it is really gone),
   statement shapes (`isPhase1StatementList` ⇄ statement lowering throws).
   Each family = one PR: add rows + rewire the two consumers + a conformance
   test proving every `claim` row is backed by a lowering.
2. **`claim-partial` is explicit, not hidden.** The original spec wanted
   from-ast throws to become `unreachable` assertions "where the table says
   claimable" — that is only sound for FULL claims. A partial claim's
   residual throw is a *documented demote*, not a bug; conflating the two
   would either hard-error legitimate residuals or silently bless drift.
   The three-state table encodes the difference; the endgame (#2855) is
   claim-partial → claim row by row.
3. **Mode-gated capabilities (coordination with #2856).** dev-2856f's
   extern-in-IR arms (HostMemberGet/HostMethodCall) are JS-host-lane-only.
   The agreed shape: add their guards to `capability.ts` as predicate
   functions carrying a mode parameter (e.g.
   `canHostMemberGet(node, mode): IrOpCapability`), consumed by both sides
   like the op tables. `claim-partial` is the right state for a new family
   while its lowering matures — and #2138's skip set treats partial claims
   safely (a skipped-then-failed function is a loud error; conservative
   exclusion from the skip set is available if flag-on noise matters).

### Verification (slice 1)

- `tests/issue-2135.test.ts` (5): defer ops selector-rejected + zero
  post-claim errors + correct legacy execution (`%`, `**`, `in`, `~`);
  claim ops selector-accepted + IR-compiled with zero post-claim errors +
  correct results (arith/compare/logical/bitwise/prefix probes); `??`
  claim-partial residual intact; table sanity (retired rows exactly defer,
  unknown ops default defer).
- `check:ir-fallbacks` green against the refreshed baseline; post-claim
  demotions remain "(none)" on the corpus.
- Pre-existing `__unbox_number` harness LinkErrors in
  `tests/ir-numeric-bool-equivalence.test.ts` (28) are unchanged and
  identical on the merge base — not introduced by this slice.
