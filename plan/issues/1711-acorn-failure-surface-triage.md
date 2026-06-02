---
id: 1711
title: "acorn failure-surface triage: bucket harness output + file sized child issues"
status: done
created: 2026-05-29
updated: 2026-06-02
completed: 2026-05-29
priority: high
feasibility: medium
reasoning_effort: medium
task_type: planning
area: triage
language_feature: n/a
goal: self-hosting-dogfood
sprint: 58
depends_on: [1710]
required_by: [1712]
child_issues: [1725]
es_edition: multi
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

## Triage results — run 2026-05-29 (acorn 8.16.0, main 29bc76539)

Harness: `pnpm run dogfood:acorn` → `tests/dogfood/report/acorn-surface.json`.

**Headline:** `compile()` `success=true` (827,839-byte binary, 471
diagnostics) but `WebAssembly.compile()` **INVALID** — the binary does not
validate, so all 5 runtime-AST-diff fixtures are skipped. The surface is
therefore dominated by a **single codegen-acceptance blocker**; no
runtime-divergence (AST) data is reachable until it clears.

### Failure-surface table

| # | Surface entry | Class | Count | Root cause | Tracking | Size | RW weight |
|---|---------------|-------|------:|-----------|----------|------|-----------|
| 1 | `WebAssembly.compile(): __fnctor_Parser_new failed: any.convert_extern[0] expected externref, found ref.cast null of type (ref null 94)` | codegen-acceptance (invalid Wasm) | 1 (blocks all) | functor-constructor body emits `any.convert_extern` on a `ref.cast`-narrowed struct ref instead of `extern.convert_any` from anyref | **NEW → #1725** | M | **HIGH** (Parser ctor = acorn hot path; gates everything) |
| 2 | `Property 'X' does not exist on type 'Y'` | ts-property-noise | 464 | untyped JS through TS checker | not filed — known noise (#1679/#1690) | — | — |
| 3 | `Object is possibly 'undefined'` | ts-possibly-null | 3 | same untyped-JS checker noise | not filed — known noise | — | — |
| 4 | `comparison … types 'number' and 'string' have no overlap` (1); `body of statement cannot be the empty statement` (1); `Operator 'X' cannot be applied to types 'X' and 'X'` (2) | "other" diagnostics | 4 | TS-checker diagnostics on untyped acorn JS; **not** `success:false` errors (compile succeeded) | not filed — non-blocking diagnostics | — | — |
| 5 | runtime AST divergence (per-node, per-option) | runtime-divergence | 0 observed | **unreachable** — binary invalid, run+diff skipped | re-run after #1725 lands | — | — |

### Conclusions

- **One** genuine, un-tracked root cause → filed as **#1725** (functor
  constructor `any.convert_extern` on non-extern ref). It is the sole gate on
  the entire acorn surface.
- The prior two acorn blockers are **closed**: #1679 (`new this(...)`) and
  #1690 (`isInAstralSet` stale module-global index). #1725 is the third in the
  sequence, distinct from both (different function, different validator error).
- **No runtime-divergence (AST) gaps are observable yet** — they are the
  higher-value, harder-to-find class (acceptance #3), but they only become
  reachable once #1725 makes the binary validate. This issue is re-run each
  dogfood lap; the next run after #1725 lands is expected to expose the AST
  layer for the 5 fixtures (`arith/class/control/fn/strings`).
- The oracle self-check passed (`identicalSourcesEqual && differingSourcesDivergent`),
  so the diff harness itself is sound — the skip is purely the red binary.
