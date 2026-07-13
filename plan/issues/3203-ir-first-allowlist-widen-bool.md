---
id: 3203
title: "IR-first allowlist widen: f64 → f64+boolean (Phase-3a enabler)"
status: done
assignee: ttraenkler/opus-sendev
sprint: 71
created: 2026-07-13
updated: 2026-07-13
completed: 2026-07-13
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: refactor
area: ir, codegen
language_feature: compiler-internals
goal: ir-full-coverage
parent: 2855
related: [3143, 3090, 2856, 2138]
loc-budget-allow:
  - src/codegen/index.ts
---

# #3203 — IR-first allowlist widen: f64 → f64 + boolean

First real **Phase-3a enabler** after the #3143 IR-first-default flip. The flip
landed with a conservative **v1 allowlist** (`computeIrFirstSkipSet` +
`irFirstBodyIsProvenLowerable`) that skips legacy body emission ONLY for
functions whose signature is pure-`f64` and whose whole body is the
proven-lowerable numeric subset. This widens the value domain to add **boolean**.

## Why this is the right first slice (not a deletion)

Scoping (see #3090 finding, reported to lead): the flip cleared **G1 for the
numeric population only**. Measured skip rate on the ir-fallbacks corpus was
**6/50 = 12%** — the other 88% still compile via legacy, so **G2 keeps every
per-kind legacy handler reachable**. No frontend handler is deletable yet
(the audit's frontend `legacy-only` count went UP 59,976→61,889 post-flip).
The −60k payoff unlocks per-file as each file's LAST gate closes, which requires
**widening the allowlist** so more functions are IR-owned. This is that first
widen.

## Design (safe-by-construction)

`boolean` and native-int BOTH carry as Wasm `i32` (`resolvePositionType`
`BooleanKeyword → irVal i32`), so the resolved override type cannot
disambiguate bool from native-int checker-free. **v1 resolves the ambiguity
structurally**: a position is `bool` domain ONLY when its resolved type is `i32`
AND it carries an explicit `boolean` AST annotation. Unannotated-`i32` and
native-int stay compile-twice (native-i32 is a clean follow-up slice).

- **Signature** (`computeIrFirstSkipSet`, index.ts): each param resolves to a
  domain in {`number` (f64), `bool` (i32 + `boolean` annotation)}; return in
  {`number`, `bool`, `void`}. Anything else -> not skip-eligible.
- **Body walk** (`irFirstBodyIsProvenLowerable`, ir-first-gate.ts): tracks a
  per-name value-domain map (params seeded from signature, locals inferred from
  initializer). `exprDomain(e)` returns `number`/`bool`/`null`. Enforces:
  arithmetic/bit/shift over numbers -> number; relational compares over numbers
  -> bool; equality over MATCHED domains -> bool; `&&`/`||`/`!` over bools ->
  bool; `?:` branches same-domain; assignment/`++`/`--` domain-matched (bool
  only via `=`); if/while/do/for conditions must be `bool`; `return` must match
  the function's return domain.
- **Calls stay number-only (v1)**: `claimedArity` is tightened to claimed
  callees with a **pure-f64 signature** (all params f64, f64 return). A call is
  number-domain to such a callee only. This ALSO closes a latent hole in the
  f64-only allowlist (a call to a claimed non-f64-return callee was accepted as
  number). Bool values never flow through inter-function calls in v1.
- The **signature-parity fixpoint** (skip only when every caller is skipped) is
  unchanged - conservative and load-bearing.

Safe by construction: any shape the walk does not recognise keeps the function
COMPILE-TWICE (correct, never a skipped-slot hard error). Behavior-preserving -
the widen only changes WHICH functions skip legacy body emission; the IR path
already lowered these (bool functions are already IR-claimed, just compile-twice).

## Acceptance criteria

- `irFirstBodyIsProvenLowerable` accepts bool-domain bodies (bool params/returns,
  bool literals, logical ops, comparisons, bool equality, bool ternary) and
  rejects mixed-domain shapes; existing f64 cases unchanged (default domains).
- Zero `[IR-FIRST skipped-slot]` hard errors on the equivalence-inline corpus +
  merge_group (net-non-negative required - broad impact).
- Measurable skip-rate increase on the ir-fallbacks corpus vs the 12% baseline.
- Cross-backend parity preserved.

## Validation

- `tsc`, `check:loc-budget`, `check:ir-fallbacks`
- Full merge_group (broad-impact; standalone floor + merge-shard reports run there)
- New unit tests in `tests/issue-3203.test.ts` (bool accept/reject + e2e
  no-hard-error + escape-hatch parity)

## Follow-ups (sequenced, NOT this PR)

- Native-i32 (`type i32 = number`) domain widen (deferred - mixed-domain arith).
- Closest-to-closing leaf-file gate readout for the first real Phase-3b deletion.
