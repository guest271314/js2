---
id: 3143
title: "Flip IR-first (JS2WASM_IR_FIRST) to default — clears gate G1 of the legacy-frontend retirement"
status: blocked
sprint: current
assignee: ttraenkler/fable-shrink
created: 2026-07-11
updated: 2026-07-11
blocked_on: "selector↔builder capability alignment (#2855/#2949 track) — see ## CI A/B divergence (banked 2026-07-11) below"
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
depends_on: [2856]
related: [2138, 3090, 2855]
origin: "plan/bloat-reduction-battle-plan.md slice 4; gate G1 in plan/log/3090-phase0-legacy-delete-list.md"
loc-budget-allow:
  - src/codegen/index.ts
---

<!-- loc-budget-allow rationale (#3131): the flip's +21 in the barrel/driver
`src/codegen/index.ts` is the `explicitlyDisabledEnv` escape-hatch helper +
the gate-7 docblock and gate line, which structurally belong to the IR-first
pipeline block in `generateModule`. Gate-7's own scan helper went into the
subsystem module `src/codegen/ir-first-gate.ts`, not the barrel. -->

# #3143 — Make IR-first compilation the default (gate G1)

## Problem

Today the IR is an **overlay**: legacy compiles every function first, then IR-compiled
bodies replace legacy bodies (`src/codegen/index.ts` overlay block ~:2096). #2138
(done) built the inversion behind `JS2WASM_IR_FIRST=1` — legacy emission is skipped
for claimed functions — but it is **not the default**. Gate **G1** in
`plan/log/3090-phase0-legacy-delete-list.md`: *no live legacy handler can be deleted
until IR-first is the default*, because the overlay keeps every handler reachable.

## Implementation Plan (architect)

1. **Precondition**: #2856 (`body-shape-rejected` → 0) landed — the last unintended
   fallback bucket; flipping earlier just widens the population where IR-first vs
   overlay can diverge.
2. **Flip**: default the IR-first path on in `src/codegen/index.ts` (keep
   `JS2WASM_IR_FIRST=0` as an escape hatch for one release); keep the demote-to-legacy
   fallback for *rejected* functions unchanged.
3. **Measure**: full-corpus A/B on CI sharded test262 (host + standalone lanes) —
   net ≥ 0, no async/generator bucket regression. This changes which emitter produced
   every claimed function's bytes; it is NOT byte-inert — the merge_group standalone
   floor is the hard gate.
4. **Bank**: promote the zeroed rejection reasons into `STRICT_IR_REASONS`
   (`src/codegen/index.ts`) per the #2855 ratchet so regressions become hard errors.

## Acceptance criteria

- IR-first is the default compile mode; overlay path behind the escape-hatch env only.
- test262 net ≥ 0 on merge_group; ir-fallback baseline unchanged or lower.
- `plan/log/3090-phase0-legacy-delete-list.md` G1 marked cleared (unblocks Phase 3a).

## Implementation notes (2026-07-11, fable-shrink)

- Gate line (`src/codegen/index.ts` ~:2100): `!explicitlyDisabledEnv(JS2WASM_IR_FIRST)`
  — default ON under `experimentalIR`; only explicit `0`/`false` disables
  (one-release escape hatch). `disableIrFirst` (#2973 eval/new-Function
  sub-compiles) unchanged.
- **New gate 7** (`irFirstBodyHasNullish`, `src/codegen/ir-first-gate.ts`):
  functions containing `??`/`??=` stay compile-twice. `lowerNullish` covers
  only reference-shaped operand pairs; without the gate the flip promoted the
  documented metered `??` residual demote (#2135) to a skipped-slot hard
  compile error (caught by `tests/issue-2135.test.ts` pre-PR). Retire the
  gate when `lowerNullish` covers all operand shapes.
- Off-arm test/sweep stubs switched from unset/`""` to explicit `"0"`
  (issue-2138/2951/2945/2972, `scripts/ir-first-sweep.mts`).
- Coordinated with fable-irflip: buckets = body-shape-rejected 15 (never
  claimed → out of the A/B population), post-claim demotions 0; no file
  conflict (they work in `src/ir/*`).
- STRICT_IR_REASONS banking (plan step 4) deliberately deferred to a
  follow-up PR so the flip's A/B stays clean.
- The `test262-sharded.yml` `ir_first` dispatch input is now vestigial
  (its `'1'` equals the default); repurpose to `'0'` later if a legacy-lane
  measurement is ever needed.

## CI A/B divergence (banked 2026-07-11, fable-shrink) — WHY THIS IS BLOCKED

The naive flip (default-on gate + gate-7 `??`) produced a **large systemic
equivalence divergence** in CI (PR #2891): 50+ `equivalence-gate` regressions
across ~14 unrelated feature files + `cross-backend-parity` failures. **Set
back to `blocked`; PR #2891 left as DRAFT** (banked branch, not landed).

### Root cause (single, structural)

`computeIrFirstSkipSet` skips functions in `plan.safeSelection.funcs`, which
comes from the **static selector** (`planIrCompilation`). The selector does
**NOT trial-lower** — the real `from-ast` lowering runs later
(post-`compileDeclarations`). So the selector **claims functions the IR
builder cannot actually lower**. Under the overlay a builder `throw` is
caught and the **pre-emitted legacy body** is used (a metered demote). Under
IR-first the legacy body was **skipped** (placeholder `unreachable`), so the
same `throw` becomes a **hard `[IR-FIRST skipped-slot, #2138]` compile
error**.

Concrete (from `cross-backend-parity`):
`ir/from-ast: method call .charCodeAt(...) on string not in slice 4 [IR-FIRST skipped-slot]`
(also `.indexOf`, `.flat`, …).

### Divergence surface (all builder-throw sites the selector doesn't mirror)

string-methods (charAt/charCodeAt/indexOf/lastIndexOf/padStart/padEnd/repeat/
replace/replaceAll/split/substring/slice/trim/trimStart/trimEnd), string
relational `<`/`>`/`<=`/`>=`, unary `+` coercion, `Symbol.toPrimitive`,
template-literal number coercion, ternary-with-string-result,
toString/valueOf, try-catch-finally shapes, non-numeric sort. **Gate 7
(`??`) was one instance of this whole class.**

### Why per-shape gate patching is the wrong fix

Denylisting each unlowerable shape (the gate-4/5/6/7 pattern) does not scale:
the surface is broad, lives as `throw` sites in `from-ast.ts`, and any missed
case ships a **divergent** flip.

### Two proper fixes (next window)

- **(A) Selector precision** — mirror every `from-ast` throw condition into
  `capability.ts` / `select.ts` so `safeSelection` == true buildability. This
  is the **#2855 / #2949** track (align claim with builder). Preferred:
  it also shrinks the fallback buckets.
- **(B) Pipeline reorder** — trial-lower via `from-ast` FIRST, skip legacy
  only for functions that lowered clean (compile-once for proven successes).
  Cleanest correctness guarantee, but a real ordering change to
  `generateModule`.

### Same-day middle path (evaluated, deferred)

Replace the skip **denylist** with a conservative **allowlist** gate — skip
only functions whose body is provably in a small lowerable set (numeric
arithmetic/compare, control flow, local calls, returns; **no** method calls /
string ops / coercion). Safe-by-construction *iff* the allowlist is a strict
subset of buildable; lands a reduced (pure-function-only) flip that still
clears G1 for that population. Risk: a single mis-classified construct
re-introduces divergence, and it can't be fully validated without a CI A/B
round-trip. Not taken under the closing-window constraint.

### Resume instructions

1. Branch `issue-3143-ir-first-default-flip` (banked, DRAFT PR #2891) has the
   default-on gate + gate-7 + loc-budget allowance + doc/test updates —
   re-usable once the skip set is buildability-accurate.
2. Land fix (A) or (B) first (own issue/slice), THEN re-open #2891, re-merge
   `origin/main`, run the full CI A/B. Merge only when `equivalence-gate` and
   `cross-backend-parity` are green.
3. On landing: flip `status: done`, mark G1 cleared in
   `plan/log/3090-phase0-legacy-delete-list.md` (already staged there — revert
   that edit if the flip is materially reworked).
