---
id: 3508
title: "Advance the optional Porffor integration pin to pre-alpha 9"
status: in-progress
assignee: ttraenkler/codex-senior-3508
created: 2026-07-21
updated: 2026-07-21
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: infrastructure
area: ir, backend, tooling
language_feature: compiler-internals
goal: backend-agnostic-ir
parent: 3288
depends_on: []
related: [3295, 3297, 3299, 3300, 3478, 3482, 3498, 3499, 3500, 3501, 3502]
origin: "2026-07-21 user directive: pin exact Porffor pre-alpha 9 main and prove compatibility before the canonical landing benchmark"
---

# #3508 - Advance the optional Porffor integration pin to pre-alpha 9

## Objective

Advance `vendor/Porffor` from
`60a1d41d60580ff4faa38ffd5f7783d23df68bad` (pre-alpha 4) to the exact
Porffor `main` commit `257e8437bea2f00c8a1453a325561071d32be9cd`
(pre-alpha 9), migrate only the compatibility surface that changed, and prove
the optional JS2 IR/C integration before the canonical four-lane benchmark is
landed separately.

The shared `LinearMemoryPlan` remains target-neutral. This maintenance slice
may adapt the Porffor edge but must not narrow shared layout, allocation, or
analysis contracts around Porffor's experimental IR.

## Upstream audit

The old pin is an ancestor of the new pin, with 20 intervening commits. The
complete diff changes 15 files (`232` insertions, `249` deletions). Only two
changes affect JS2's frozen IR/C renderer boundary:

1. `e94dfede5cf5d1b67bf3a82261211370f38bd29a` removes the unused `ToNum`
   IR constructor and renderer arm. This shifts `JvTruthy` and every later `K`
   ordinal down by one; JS2 never emitted `ToNum`, so only the enum fingerprint
   and ordinal-derived nodes need migration.
2. `33f09c247be062082ea85eccb9f23f5b3774b096` reduces
   `Alloc(bytes, typeId, siteId, raw)` to `Alloc(bytes, typeId)` and fixes slot
   C to zero. JS2 had used the ignored slot as adapter-local `[siteId, raw]`
   metadata. Allocation class and provenance are already resolved from
   `LinearMemoryPlan` before final Porffor assembly, so the correct migration
   is to stop leaking that metadata into upstream IR rather than changing the
   shared plan.

The six-slot node layout, all `T` and `FX` entries, renderer input fields
`{ funcs, data, globals, entry, prefs, usedTypes }`, function record fields,
and renderer arity remain unchanged. Other renderer changes in the range alter
uncaught-error text and REPL output only and do not affect JS2's emitted
surface.

`git ls-remote origin refs/heads/main` in `vendor/Porffor` returned exactly
`257e8437bea2f00c8a1453a325561071d32be9cd`; the submodule is detached at that
commit rather than following a branch.

## Implementation notes

- Remove `ToNum` from the exact `K` fingerprint and update the pinned commit.
- Add an `Alloc` constructor probe so a future pin cannot silently reintroduce
  a slot-C schema mismatch.
- Emit slot C as zero for every final Porffor `Alloc` node. Keep site IDs and
  allocation-class decisions in the shared plan and pre-assembly expression,
  where they continue to drive stack-versus-arena selection.
- Keep the optional submodule's `update = none` policy, but change its ignore
  policy from `all` to `dirty`. This continues to ignore edits inside the
  Porffor worktree while making a checked-out commit/gitlink mismatch visible;
  the compatibility suite freezes both settings to prevent regression.
- Refresh the four exact plain-Porffor generated-C byte fingerprints. The
  pre-alpha 9 renderer adds `670` bytes to each raw CLI artifact without
  changing the accepted kernel outputs.
- Do not change Porffor's object layout, JS2's layouts, the value ABI, or the
  shared planner.

## Acceptance criteria

- [ ] `vendor/Porffor` is pinned exactly to
      `257e8437bea2f00c8a1453a325561071d32be9cd`, detached from floating `main`.
- [ ] `.gitmodules` retains `update = none`, uses `ignore = dirty`, and no
      longer hides a Porffor checkout/gitlink mismatch with `ignore = all`.
- [ ] The compatibility fingerprint validates pre-alpha 9 enums, slots,
      `Alloc` shape, records, and real C rendering.
- [ ] Focused Porffor IR conformance/parity and all four-kernel landing support
      tests pass.
- [ ] JS2-generated native C is clean under combined ASan+UBSan.
- [ ] Plain pre-alpha 9 Porffor sanitizer evidence classifies whether the known
      20-byte-stride/misaligned-`f64` finding remains, changed, or is fixed.
- [ ] Relevant guards plus typecheck, lint, and formatting checks pass.
- [ ] The ready PR excludes
      `.github/workflows/landing-four-lane-backend.yml` and
      `docs/benchmarks/landing-four-lane-backend.md`.

## Validation

Pending implementation and the complete requested compatibility matrix.
