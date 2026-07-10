---
id: 2762
title: "Hybrid migration-cost audit: type-directed fast-path safety-predicate checklist (living doc)"
status: done
sprint: 69
created: 2026-06-28
updated: 2026-07-03
completed: 2026-06-28
priority: high
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: architecture
area: codegen, ir
language_feature: none
goal: maintainability
related: [2755, 2760, 2766, 1530]
---

# #2762 — Hybrid migration-cost audit: fast-path safety-predicate checklist

> **Deliverable produced (R3, 2026-06-28):** the living checklist lives at
> [`plan/log/hybrid-fastpath-audit.md`](../log/hybrid-fastpath-audit.md). It
> covers all ~9 fast-path families with, per row: the unsound assumption, the
> proof `P` that makes it HI-safe, the discharged/partial/undischarged status,
> the easy/subtle class + S/M/L effort, the concrete codegen site
> (`file:approx-symbol`), and a "what would discharge `P`" note for every
> subtle/undischarged row. The roadmap §(d) is cross-linked to it. This issue
> file is the *tracking record*; maintain the table in the living doc, not here.

Makes the migration-cost sizing from the hybrid roadmap
([`docs/architecture/hybrid-soundness-ir-roadmap.md`](../../docs/architecture/hybrid-soundness-ir-roadmap.md),
§(d)) **dispatchable** by turning it into a living, per-fast-path checklist that
tracks the discharged/undischarged state of each safety predicate `P`. This is
the backlog generator for the M/L specialization items.

## Problem

The hybrid invariant requires that every type-directed fast path be either
*already proof-gated* or *converted to prove-then-specialize*. The roadmap §(d)
enumerates ~9 fast-path families with a safety predicate and an effort band, but
that table is a snapshot. We need a **tracked checklist** so each path's status
is visible and convertible into its own issue when worked.

## Scope (no compiler code — a tracking/checklist deliverable)

Produce and maintain a per-fast-path table (in this issue, or a dedicated
`plan/log/hybrid-fastpath-audit.md`) with, for each path:

| Field | Meaning |
|-------|---------|
| Fast path | name + anchor (file:line) |
| Safety predicate `P` | the proof HI requires |
| Status | `discharged` / `partial` / `undischarged` |
| Gating analysis | which existing analysis discharges `P` (or "none yet") |
| Class | easy / subtle |
| Effort | S / M / L |
| Follow-up | issue id once converted, or "—" |

Seed it from roadmap §(d):

1. IR `vec.get` element read — `from-ast.ts:1919/1990` — `P`: index ∈ [0,len) —
   **partial** (being addressed by #2766) — counted-loop/literal proof — M.
2. Legacy bounds-eliminated read — `property-access.ts:5371,6333` — `P`:
   counted-loop bound — **discharged** — `safeIndexedArrays` — S.
3. Packed-`i32` arrays — `array-element-typing.ts:44,212` — `P`: all writes
   i32-safe ints, no NaN/fractional/large read distinction — **undischarged
   (subtle)** — `collectI32SpecializedArrays` approximates — L.
4. Monomorphic `struct.get`/`set` — `property-access.ts` (`resolveStructName`,
   `emitNullGuardedStructGet`) — `P`: receiver provably nominal, no union/`any`/
   divergent-subclass — **undischarged (subtle)** — IR receiver narrowing — L.
5. Unboxed `f64`/`i32` number locals — `P`: value never escapes to any/externref
   sink unboxed — **partial** — IR escape analysis (`escape.ts:92`) — M.
6. `ArrayLiteral` → `vec.new_fixed` — `from-ast.ts` (#1804) — `P`: same static
   element type, not later widened — **partial (local)** — S.
7. `Binary` unboxed arithmetic — `from-ast.ts:3787`; `binary-ops.ts` — `P`:
   operands provably number, `+` not string-`+` — **partial** — M.
8. `this`-receiver typed read — `property-access.ts:5405` — `P`: runtime
   `ref.test` guard — **discharged (exemplar)** — S.
9. Typed-array element read — `property-access.ts:6285–6316`;
   `array-methods.ts:386` — `P`: view length bound, OOB → undefined —
   **partial** (kept separate from #2760 plain-array scope) — S–M.

## Deliverable / acceptance criteria
- A committed, maintainable checklist (this issue body or
  `plan/log/hybrid-fastpath-audit.md`) covering all rows above.
- Each `undischarged`/`partial` subtle row (3, 4, and the general arms of 1/5/7)
  has a one-line "what would discharge `P`" note so it can be spun into its own
  proof-gated follow-up issue.
- Cross-linked from the roadmap doc's §(d).
