---
id: 3317
title: "standalone: Array.prototype.{indexOf,lastIndexOf,includes} — ToNumber-of-object length/fromIndex + includes abrupt-getter length reads"
status: ready
sprint: current
created: 2026-07-16
priority: medium
feasibility: hard
horizon: m
task_type: bug
area: codegen
goal: standalone-mode
umbrella: 2860
related: [3170, 2860]
origin: "PO re-scope split of #3170 (2026-07-16) — buckets 3 and 5 of the verified 42-test residual, the two judged most tractable"
---

# #3317 — array search methods: object-valued length/fromIndex ToNumber + includes abrupt getters

## Context

Split from #3170 after its verify-first measurement showed the original
`≥90 flips` acceptance criteria is unreachable post-#3169 (only 42 total gap
tests remain, most infrastructure-blocked). This issue carries the two
buckets #3170 judged most tractable as standalone next steps. See #3170's
"Verify-first findings" section for the full residual-42 breakdown and how
these buckets were isolated.

## Scope

**Bucket 3 — ToNumber of an object-valued `length`/`fromIndex` (~6 tests)**:
`-3-19`/`-3-20` (object `length` with `toString`/`valueOf`),
`lastIndexOf/-5-21` (object `fromIndex`). No single ToNumber-of-externref
helper exists today for this path; needs `__to_primitive`→ToNumber wired into
the closed-struct `__extern_length` arm / the fromIndex coercion path, WITH
correct spec side-effect ordering (`-3-21`) and abrupt-throw propagation
(`-3-22`).

**Bucket 5 — `includes` return-abrupt getters (4 tests)**:
`includes.call({get length(){throw}}, …)` inside `assert_throws` currently
traps "illegal cast in `__closure`" instead of propagating the thrown value —
accessor-getter invocation from `__extern_length` needs the same abrupt-throw
plumbing as bucket 3's ToNumber path (they likely share a fix site).

## Explicitly out of scope (do not drive-by fix here)

- Exotic host-object receivers, primitive receivers, real-array
  null/undefined identity — see #3170's buckets 1/2/4, tracked separately
  (bucket 4 is substrate-blocked on the undefined-singleton work, #2106).
- The CE crash (`Cannot create property 'declaredType' on number`) — split
  to #3318, unrelated mechanism.
- The 2 harness/vacuity-artifact gap rows (`-9-5`/`-8-5`) — not a real gap,
  flag to whoever owns the #3086 honest-vacuity oracle instead of fixing here.

## Acceptance criteria

- Buckets 3 and 5 (~10 tests total) flip to host-free standalone passes,
  OR are shown to require infrastructure beyond this issue's reasonable
  scope (in which case, re-split further rather than force a fix).
- Zero host-mode regressions; zero standalone high-water regressions.
- No changes outside the search-method dispatch / length-read coercion path.
