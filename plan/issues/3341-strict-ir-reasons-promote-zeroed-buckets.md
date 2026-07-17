---
id: 3341
title: "STRICT_IR_REASONS hardening — per-reason (NOT a corpus-zero flip); doc-correction shipped, real per-reason work remains"
status: ready
sprint: current
created: 2026-07-17
priority: medium
feasibility: hard
horizon: m
task_type: feature
area: codegen
language_feature: compiler-internals
goal: compiler-architecture
related: [2855, 2856, 2857, 2858, 2859, 2950]
origin: "carved out of #2855's umbrella scope per the 2026-07-17 IR audit (plan/log/analysis-2026-07/01-ir-audit-2026-07-17.md §2) — the promotion half of #2855's AC has not started even though the underlying buckets are already zero"
loc-budget-allow:
  # (#3341) +15-line rationale comment at STRICT_IR_REASONS documenting the
  # necessary-but-not-sufficient corpus-zero condition (build-safety guardrail).
  - src/codegen/index.ts
---

# #3341 — STRICT_IR_REASONS hardening (per-reason)

> **RE-SCOPED 2026-07-17 (opus-c, confirmed by tech lead).** The original
> premise — "the buckets are already zero, so promoting the reasons into
> `STRICT_IR_REASONS` is the cheapest unstarted hardening step" — is **UNSAFE**
> and has been corrected. Bucket-zero in `scripts/ir-fallback-baseline.json` is
> measured against the **13-file playground corpus only**; corpus-zero does
> **not** mean the reason is unreachable on real code. `external-call`,
> `call-graph-closure`, `param/return-type-not-resolvable`,
> `type-resolution-failure`, `class-method`, and the destructuring-param buckets
> all describe **legitimate IR-non-claimability** (an external dependency, an
> unclaimable callee, an unresolvable type, a computed/generator/abstract method
> name) that the legacy path must still catch. Adding any of them to
> `STRICT_IR_REASONS` would turn those legitimate fallbacks into **hard compile
> errors** and regress real programs — an unvalidatable-locally, broad-blast
> change. `ir-adoption.md`'s `class-method` row already documented exactly this
> ("corpus bucket 0 … NOT yet strict"); the same logic applies to every other
> corpus-zero reason.
>
> **What shipped (the doc-correction portion, DONE):**
>
> - Fixed the stale `src/codegen/index.ts:889–896` citations (actual demote
>   sites are `~1889` for a selector-claimed unresolvable-types fallback and
>   `~2390` for an IR-build throw) in `scripts/gen-ir-adoption.mjs` (→ regenerated
>   `plan/log/ir-adoption.md`) and `docs/architecture/codegen-axes.md`.
> - Added a code-comment at `STRICT_IR_REASONS` (`src/codegen/index.ts`)
>   explaining the necessary-but-not-sufficient condition, so no future dev
>   naively flips a corpus-zero reason and reddens the build.
> - Documented the per-reason (not corpus-flip) promotion rule in
>   `codegen-axes.md`'s escape-hatch section.
>
> **What remains OPEN (this issue stays `ready`):** the _actual_ per-reason
> hardening — pick ONE reason, do the real #2855-family IR-adoption work to make
> that construct genuinely unreachable in the IR (IR always claims+lowers it, so
> a rejection IS a bug), THEN add it to `STRICT_IR_REASONS` and validate on full
> CI. That is `feasibility: hard`, not a doc flip. The stale `lower.ts`
> "not yet moved" claim in `codegen-axes.md` (aggregate/closure/ref-coercion
> groups) was NOT touched here — it needs a `lower.ts` audit to confirm before
> editing; folded into the remaining work.

## Original problem (premise now corrected — see re-scope note above)

## Problem

`STRICT_IR_REASONS` (`src/codegen/index.ts:1511`) is still the empty set.
Per `docs/architecture/codegen-axes.md` and CLAUDE.md's IR Fallback Budget
section, once an "unintended" fallback bucket hits zero on the corpus, its
reason is supposed to be promoted into `STRICT_IR_REASONS` — turning any
_future_ regression of that reason from a silently-demoted legacy fallback
into a hard compile error. Nobody has done this promotion, even though the
following reasons are already at zero on the `scripts/ir-fallback-baseline.json`
corpus as of 2026-07-17 (verified via `pnpm run check:ir-fallbacks -- --verbose`):

- `call-graph-closure` (#2858, done)
- `class-method` (#2857 + #3000 B/C/E, done)
- `param-type-not-resolvable` (#2859, done)
- `external-call`, `param-shape-rejected`, `destructuring-param-complex`,
  `return-type-not-resolvable`, `type-resolution-failure` — already absent
  from the baseline's `unintended` section.

This is the single cheapest, already-unblocked hardening step available in
the #2855 umbrella — no new codegen work needed, just closing the loop on
work already done.

**Note**: `body-shape-rejected` (still 14, #2856 in-progress) and
`async-function`/`type-parameters`/`non-export-modifier`/`unnamed` (deferred
category) are NOT in scope here — only the reasons already at zero.

## Task

1. Move the reasons listed above from the demote-to-warning channel into
   `STRICT_IR_REASONS` (`src/codegen/index.ts:1511`).
2. **Caveat that must be handled, not skipped** (per the audit): baseline
   zero is measured against the 13-file playground corpus only. A reason
   can be zero-on-corpus but still legitimately fire on real user code —
   promoting it to a hard error is only safe if firing it SHOULD actually be
   an error (i.e. the fallback reason represents a case the IR is now
   expected to always handle), not just "we happen not to have a test for
   it." Check `plan/log/ir-adoption.md`'s per-reason notes (the class-method
   row already flags this exact distinction: "corpus bucket 0 … NOT yet
   strict") before promoting each reason — promote only the ones where
   zero-on-corpus genuinely means "should never happen," and leave the rest
   demoted with a note explaining why.
3. Run the full existing test suite + `pnpm run check:ir-fallbacks` to
   confirm no live corpus code trips a newly-strict reason (if it does,
   that's real signal the promotion was premature for that reason — back it
   out, don't suppress).
4. Fix the two stale demote-channel line-number citations found by the
   audit while you're in this code (`plan/log/ir-adoption.md` still says
   `index.ts:889-896`; actual location is ~1891/2390 as of 2026-07-17) and
   in `docs/architecture/codegen-axes.md` (same stale citation, plus a
   stale "not yet moved" claim about the aggregate/closure/ref-coercion
   groups in `lower.ts` — see #2855's audit-note for detail).

## Acceptance criteria

- Every reason promoted is justified in the commit/PR body with the
  corpus-vs-strict reasoning, not just "it was zero so I promoted it."
- Full test suite green; `check:ir-fallbacks` gate green.
- Stale line-number citations in `ir-adoption.md` and `codegen-axes.md`
  corrected.
- `plan/issues/2855-ir-frontend-migration-ratchet-buckets-to-zero.md` updated
  to reflect this slice as done against its own AC (don't close #2855 itself —
  `body-shape-rejected` remains open via #2856).
