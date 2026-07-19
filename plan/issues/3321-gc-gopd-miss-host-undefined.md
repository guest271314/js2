---
id: 3321
title: "gc/host lane: typed-receiver gOPD miss answers null extern instead of the host undefined sentinel — the host twin of #3319's miss family"
status: done
assignee: ttraenkler/fable-3316
completed: 2026-07-16
sprint: 72
created: 2026-07-16
priority: medium
horizon: s
feasibility: medium
model: fable
task_type: bug
area: codegen
language_feature: object-property-descriptors
goal: standalone-mode
related: [3319, 3316, 2874, 2106]
origin: "documented as a residual in #3319 (the two gc-scoped test skips); lead-directed follow-up with an elevated verification bar (full equivalence suite) since it is byte-NON-inert on the gc lane"
# LOC-ratchet allowance (#3102): regime-dispatch commentary at the two fixed
# miss sites in the pre-existing call lowering god-file.
loc-budget-allow:
  - src/codegen/expressions/call-builtin-static.ts
---

# #3321 — gc-lane typed-receiver gOPD miss → host `undefined` sentinel

## Problem

The `Object.getOwnPropertyDescriptor(<typed struct>, "<literal key>")` fast
path in `call-builtin-static.ts` answers a MISS with bare `ref.null.extern`
at two sites:

1. the compile-time static miss (key provably not a field), and
2. the runtime guarded-cast `else` arm (receiver fails `ref.test` at runtime).

On the **host/gc lane** JS `undefined` is the `__get_undefined` host sentinel
(a NON-null externref), so `gOPD(o, missing) === undefined` answered false
and `=== null` true — the host twin of the standalone bug #3319 fixed with
the `$undefined` singleton. Found when #3319's new tests had to gc-skip these
two shapes.

## Fix

Route both miss sites through the canonical all-lane `undefined` dispatch:

- Static miss → `emitUndefined(ctx, fctx)` (late-imports.ts): host/gc →
  `call __get_undefined`; standalone singleton regime → tag-1 singleton
  extern; legacy standalone → `ref.null.extern` (byte-identical).
- Runtime cast-fail `else` arm (baked `Instr[]`) → same three-way dispatch
  inline (`ensureGetUndefined` / `undefinedExternInstrs` / null). The import
  is resolved AFTER the then-arm's late imports (source-order property eval);
  in gc all funcIdxs baked into that `if` are env imports (idx-stable under a
  further import append), and standalone adds no import at all here — so the
  pre-push baked arrays cannot carry stale indices.

The two `it.runIf(standalone)` skips in `tests/issue-3319.test.ts` are
un-skipped — both shapes now run and pass on BOTH lanes.

## Measured (2026-07-16, fable-3316; elevated bar per lead — gc bytes change)

- `tests/issue-3319.test.ts`: **20/20** (was 18/2skip).
- SHA lane audit vs base: ONLY the gc binary of the miss shape changes;
  legacy-standalone byte-identical, unrelated gc sources byte-identical
  (surgical).
- **Full equivalence suite** (`tests/equivalence/`, 212 files / 1646 tests):
  fix-vs-base failure-NAME diff **empty in both directions** — 36 identical
  pre-existing local-env failures on both runs (CI equivalence shards are
  green on the same base), zero introduced.
- Adjacent gOPD battery re-run clean post-merge (incl. #3154's
  primitiveReceiverArm interplay): 206 pass / 2 known skips;
  `tests/issue-3319.test.ts` 20/20.

## Notes

Stacked on the #3319 branch (PR #3155, CLEAN in queue) — explicit
predecessor dependency: it edits the same miss site #3319 touched.
