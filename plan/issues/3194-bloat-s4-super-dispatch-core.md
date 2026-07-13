---
id: 3194
title: "bloat S4: new-super.ts — extract the shared super-dispatch core (compileSuperMethodCall ≈ compileSuperElementMethodCall)"
status: done
completed: 2026-07-12
assignee: ttraenkler/dev-find-wasm
created: 2026-07-12
updated: 2026-07-13
priority: high
feasibility: medium
task_type: refactor
area: codegen
es_edition: n/a
language_feature: super-dispatch
goal: maintainability
sprint: 71
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

## Resolution (2026-07-12, dev-find-wasm)

Extracted `compileSuperMethodCallCore(ctx, fctx, expr, methodName)` in
`new-super.ts`; `compileSuperMethodCall` (identifier name) and
`compileSuperElementMethodCall` (computed key) are now one-line wrappers that
pass the resolved `methodName` to the core. Net −82 LOC.

**Divergence resolved** (the #1849 2026-06-04 review flag): the element form's
no-class / no-parent fallback previously returned `null` WITHOUT pushing a
value, while the dot form evaluated args + left a return-typed default. Unified
on the value-leaving branch (spec-side-correct — the call is a value-producing
expression) via a shared `evalArgsAndDefault` helper. This is byte-inert for
every tested/common path (verified by hashing the emitted binary for
`super.m()`, `super["m"]()`, and the no-parent fallback: base == change) and the
only behavior change is the degenerate `super["x"]()`-in-extends-less-class case,
which no test exercises.

## Test Results

- `tests/issue-3194.test.ts` — 4/4 (dot≡elem across normal dispatch, multi-level
  ancestry, arg padding / extra-arg side effects, void-return branch).
- Zero test-diff: inheritance + super suites report identical pass/fail on base
  vs this change (the pre-existing `string_constants` host-import failures in the
  local harness are unrelated and present on both).
- `tsc --noEmit` clean; `check:loc-budget` OK (net −82 LOC).
