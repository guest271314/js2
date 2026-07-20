---
id: 3320
title: "stale #1888 S6/S6-b guardrails: builtin value-read compile-refusal contract was retired by #2984 (runtime refusal closures) — update to the current contract"
status: done
assignee: ttraenkler/fable-3316
completed: 2026-07-16
sprint: 72
created: 2026-07-16
priority: medium
horizon: s
feasibility: easy
model: fable
task_type: fix
area: tests
goal: standalone-mode
related: [1888, 1907, 2984, 2933, 3319]
origin: "found during #3319 validation as 2 pre-existing failures (verified failing on base); lead-approved follow-up (fable-3316, 2026-07-16)"
---

# #3320 — update the two stale #1888 refuse-loud guardrails

## Problem

Two guardrail tests asserted the OLD contract — unsupported builtin static
value-reads (`const f: any = Math.max` / `Array.from`) **refuse at compile
time** with a `#1888 S6` / `#1907` cite:

- `tests/issue-1888-s6c.test.ts > guardrail: unsupported Builtin.method
value-read still refuses-loud (S6-b lever)`
- `tests/issue-1888.test.ts > unsupported built-in static value reads refuse
loud with a #1888 cite`

Both had been failing silently for ~10 days (`expected true to be false` on
`r.success`) — another instance of the not-in-scoped-CI silent-suite gap
(#3316's "Not caught by CI" pattern).

## Root cause (bisected 2026-07-16, fable-3316)

**First bad commit: `823479ff` — merge of PR #2851 (#2984
gopd-ctor-receivers, 2026-07-06).** Deliberate contract change, not a bug:
`#2984 Phase 2/3` reifies un-wired builtin members as **identity-stable
closures that throw a catchable error at CALL time** (so gOPD descriptors are
spec-shaped and `desc.value === <Builtin>.<m>` identity holds) — replacing
the compile-time refusal the guardrails asserted. Probes on current main:
`Math.max` value-read is now genuinely native (**graduated** via #2933,
returns 2 host-free); `Array.from`/`JSON.parse`/`Object.getOwnPropertyNames`
value-reads compile to valid host-free Wasm and throw catchably at call time;
`Reflect.ownKeys` works outright.

## Fix (test-only)

Update both guardrails to the CURRENT contract, preserving their original
spirit (the S6 hazard was `__get_builtin` leakage / invalid Wasm — that must
still never happen):

- `issue-1888-s6c`: split into (a) `Math.max` graduated-pair positive test
  (native, host-free, returns 2) and (b) a still-un-wired pair (`JSON.parse`)
  compiling to valid host-free Wasm that throws catchably at call time.
- `issue-1888`: `Array.from` value-read compiles host-free + valid, call
  throws catchably in-module (try/catch returns the sentinel).

No src changes.

## Measured

- `tests/issue-1888*.test.ts`: 23/23 (was 21/23; the 2 failures verified
  pre-existing on base at bb239d65 → pass, 026f40f771 → fail bracketing).

## Residual (noted, not fixed here)

The runtime refusal-closure throw message does not cite an issue number
(probed: no `#1888`/`#1907`/"unsupport" substring). If loud attribution
matters, a follow-up could thread a cite into the refusal body message.
