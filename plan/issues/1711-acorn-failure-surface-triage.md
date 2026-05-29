---
id: 1711
title: "acorn failure-surface triage: bucket harness output + file sized child issues"
status: ready
created: 2026-05-29
updated: 2026-05-29
priority: high
feasibility: medium
reasoning_effort: medium
task_type: planning
area: triage
language_feature: n/a
es_edition: multi
goal: self-hosting-dogfood
sprint: 57
depends_on: [1710]
related: [1690, 1690b, 1679]
---
# #1711 — acorn failure-surface triage: bucket harness output + file sized child issues

## Problem

The #1710 harness produces a structured failure surface (compile errors,
validation errors, AST divergences) for compiled acorn. That surface is raw
data; it must be turned into an actionable, sized backlog. Without triage, the
dogfood loop stalls — devs cannot pick up "fix acorn" as a single issue (it is
many distinct gaps), and the real-world-weighted priority signal is lost.

## Goal

Run the #1710 harness against current main, bucket every distinct failure into
a root-cause category, and file one sized child issue per category. This is a
PO/architect triage task, not a code-fix task.

## Method

1. Run `pnpm run dogfood:acorn` (or equivalent from #1710) on current main.
2. For each entry in the surface report:
   - **Compile errors** — collapse the known TS JS-noise warnings (the
     `Property X does not exist on type Y` bucket from #1679/#1690 — NOT
     blockers). For genuine `success:false` errors, group by error message
     stem (e.g. "Unsupported new expression", "type-resolution-failure").
   - **Validation errors** — group by validator message class (the #1690
     `f64.lt expected f64, found global.get` is the index-shift class). Check
     each against existing index-shift issues (#1618, #1677, #1314) before
     filing a new one.
   - **AST divergences** — group by the construct that diverges (a specific
     node kind, a specific option like `locations`, a numeric/precision issue).
3. For each distinct, *un-tracked* root cause, create a sized child issue
   (`/create-issue`) with: a minimal repro reduced from the acorn site (not the
   whole 6k-line file), the spec citation, the affected source files, an
   estimated size, and `goal: self-hosting-dogfood`, `parent: 1711`.
4. Cross-link: any cause already covered by an open issue (#1690, #1690b, or a
   conformance bucket) gets noted in the triage table, NOT re-filed.
5. Order the resulting child issues by **real-world weight** — a gap acorn hits
   in a hot path (scanner, identifier classification) outranks a rarely-hit
   one, independent of raw test262 count.

## Acceptance criteria

1. A triage table is written into this issue (and the dogfood goal file)
   mapping every distinct failure-surface entry → root cause → tracking issue
   (existing or newly filed) → size estimate → real-world weight.
2. Every genuine, un-tracked root cause has a sized child issue filed with a
   minimal repro and spec citation. Known/noise buckets are explicitly listed
   as "not filed, reason: …".
3. The triage distinguishes *codegen-acceptance* gaps (won't compile / invalid
   Wasm) from *runtime-divergence* gaps (compiles + validates but wrong AST) —
   the latter are the higher-value, harder-to-find class.
4. No compiler code changes (planning/triage only).

## Notes / scope

- This issue is the bridge between the harness (#1710) and the fixes. It runs
  *after* #1710 lands and is re-run each dogfood lap as new gaps are cleared.
- Child issues filed here inherit `goal: self-hosting-dogfood` and may be
  pulled into Sprint 57 if small enough, or deferred to the backlog with a
  real-world-weight tag for a later sprint.
