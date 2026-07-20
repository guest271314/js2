---
id: 3327
title: "tests/issue-1917-coercion-plan.test.ts: 1 failure — unexpected ref.cast_null in a pinned coercion instruction shape"
status: done
assignee: ttraenkler/fable-3317
completed: 2026-07-16
sprint: 72
created: 2026-07-16
priority: low
feasibility: medium
task_type: bug
area: codegen
goal: standalone-mode
related: [1917]
origin: "found as a side-effect of #3324/#3317 validation, 2026-07-16 — pre-existing on main, unrelated to those PRs"
---

# #3327 — unexpected ref.cast_null in a pinned #1917 coercion shape

## Problem

`tests/issue-1917-coercion-plan.test.ts` has 1 failing case on unmodified
`origin/main`: an assertion pinning the exact emitted instruction shape for
one of the canonical `coercionPlan` rows (externref/ref → f64, or a
box/unbox row — see the test file for which specific case) now sees an
unexpected `ref.cast_null` instruction that wasn't part of the originally
pinned shape.

Not yet triaged whether this is:
(a) a legitimate shape change from other recent codegen work (some other PR
added a necessary cast, and the test's pinned expectation is simply
stale and needs updating), or
(b) a genuine unwanted regression — an extra cast where none should be
needed, possibly indicating a real bug in whichever change introduced it.

Given #1917's whole point is that this table is the single source of truth
multiple call sites delegate to (coercionInstrs / callArgCoercionInstrs /
fixBranchType), a wrong classification here matters more than a typical
pinned-shape test — treat (b) as the default hypothesis until ruled out.

## Task

1. Reproduce: run `tests/issue-1917-coercion-plan.test.ts` on current `main`,
   identify the exact failing case and the actual vs. expected instruction
   sequences.
2. Bisect or trace which change introduced the extra `ref.cast_null` (git
   blame on the relevant `coercionPlan` row / its consumers, or bisect if
   the history is unclear).
3. Determine (a) vs (b) per the framing above. If (a): update the pinned
   expectation with a comment explaining why the cast is now needed. If
   (b): fix the actual bug, don't just update the test to match.

## Acceptance criteria

- `tests/issue-1917-coercion-plan.test.ts` passes.
- The resolution (updated-expectation vs. real-fix) is documented in this
  issue file with the reasoning, not just silently changed.

## Resolution (2026-07-16, fable-3317): (a) stale pinned expectation

Verdict: **(a) legitimate shape change — updated the pinned expectation.**
Hypothesis (b) ruled out by tracing the cast to its introducing commit:

- **Failing case**: `coercionPlan(externref, {kind:"eqref"}, H)` — expected
  `["any.convert_extern"]`, actual `["any.convert_extern", "ref.cast_null"]`.
  The `externref → anyref` sibling assertion passes unchanged (bare
  conversion, anyref IS the exact result type of `any.convert_extern`).
- **Introducing commit**: `83d0483307ae37` — `fix(#2878): narrow
externref→eqref coercion (standalone invalid-Wasm residual)`, 2026-07-02.
  It deliberately SPLIT the old combined `externref → anyref/eqref` row:
  `any.convert_extern` yields ANYREF, the SUPERtype of eqref, so the bare
  conversion the old pin froze was one representation step too wide — a
  consuming `struct.set`/`local.set` into an eqref slot failed Wasm
  validation ("expected eqref, found anyref"; the standalone
  `__set_member_*` / `__call_toString`/`__call_valueOf` invalid-binary
  bucket, #2860/#2868 residual). The narrowing `ref.cast_null` to the
  abstract `eq` heap type (-19) is type-REQUIRED for eqref consumers:
  null passes through (nullable cast), and every concrete GC struct/array/
  i31 — the only values that legitimately land in an eqref slot — is an
  eq-subtype. Not an unwanted extra cast; removing it reintroduces the
  #2878 invalid-Wasm class.
- **Why the failure existed**: #2878's commit added its own dedicated test
  (`tests/issue-2878-externref-eqref-narrow.test.ts`, which pins the NEW
  shape) but missed this older sibling pin in
  `tests/issue-1917-coercion-plan.test.ts` — and the file is evidently not
  exercised by a CI-run shard, so main stayed green while the pin rotted.
- **Change**: updated the pinned expectation to
  `["any.convert_extern", "ref.cast_null"]` with an explanatory comment
  citing #2878; renamed the `it` to say the eqref arm adds the narrowing
  cast. No source change (none needed).

Both files green post-change: issue-1917-coercion-plan (14/14) +
issue-2878-externref-eqref-narrow — 21 tests total.
