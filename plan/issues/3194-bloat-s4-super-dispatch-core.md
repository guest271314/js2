---
id: 3194
title: "bloat S4: new-super.ts — extract the shared super-dispatch core (compileSuperMethodCall ≈ compileSuperElementMethodCall)"
status: ready
created: 2026-07-12
updated: 2026-07-12
priority: high
feasibility: medium
task_type: refactor
area: codegen
es_edition: n/a
language_feature: super-dispatch
goal: maintainability
sprint: current
horizon: s
umbrella: 3182
related: [1849, 3029, 3102]
---

# #3194 — bloat S4: extract the shared super-dispatch core

Slice **S4** of the #3182 code-bloat-elimination epic (from #1849). See
#3182 §D4.

## Problem

`compileSuperMethodCall` (`src/codegen/expressions/new-super.ts:545`) and
`compileSuperElementMethodCall` (`:666`) share a duplicated body. The
no-class / no-parent fallbacks had already **diverged** in #1849's 2026-06-04
review — re-diff first and unify on the correct (spec-side) branch,
parameterizing method-name-vs-element lookup.

## Approach (verified anchors)

- Extract one shared super-dispatch core from `new-super.ts:545` and `:666`;
  parameterize the only real difference (identifier method name vs computed
  element expression for the property lookup).
- Sweep the file for residual hand-rolled typed-default blocks;
  `pushDefaultValue` (type-coercion.ts) is already imported and used at
  `:122` / `:642` — replace any residue.

## Acceptance criteria

- Zero test-diff; the two functions share one core.
- `pnpm run typecheck` clean.

## Coordination

`new-super.ts` is a quiet file (low collision risk). Independent of S1-S3,
S5, S6.
