---
id: 3549
title: "Standalone: native RegExp step limit exceeded on `\\p{...}+` over long strings — measured 304/311 gate on RegExp property-escapes"
status: ready
created: 2026-07-23
updated: 2026-07-23
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
goal: standalone
sprint: current
horizon: l
umbrella: 2860
related: [2860, 3541, 3536, 2876, 3507, 2935]
files:
  - src/codegen/regexp-standalone.ts
---

# Native RegExp: step limit exceeded on `\p{…}+` over long strings

## Measured discovery (the #3536 → #3541 chain, 2026-07-23)

With #3536 (call-boundary) and #3541 (reflective `fromCodePoint.apply`)
landed, ALL 311 `built-ins/RegExp/property-escapes/generated/` tests were run
through the real sharded worker. **0/311 pass — the measured wall moved to
the native RegExp engine itself:**

| count | signature                                                                                                 |
| ----: | --------------------------------------------------------------------------------------------------------- |
|   304 | `RangeError: regular expression step limit exceeded`                                                      |
|     6 | `Test262Error: \p{RGI_Emoji…}/\p{Basic_Emoji} should match …` (sequence properties, `v`-mode string sets) |
|     1 | misc                                                                                                      |

The tests build multi-thousand-character strings (`buildString` — every
matching code point of a Unicode property) and assert
`RegExp("^\\p{Prop}+$", "u")` matches the whole string (and its negation
misses per-char). The 304 rows are the engine's backtracking-step cap firing
on that shape — i.e. the `\p{…}` class match is super-linear (likely a large
alternation / per-char backtrack instead of an O(1) class test per char),
so a `+` over N chars blows the step budget.

## Direction (verify against src/codegen/regexp-standalone.ts first)

1. Measure where the steps go: is `\p{…}` compiled to a range-set test
   (good) that the step counter over-charges, or expanded to alternations
   (bad)? A greedy `X+$` over N chars with an O(1) per-char class test
   should cost O(N) steps.
2. Candidate fixes, cheapest first: (a) charge class-set tests as ONE step;
   (b) raise/scale the step limit with subject length; (c) compile `\p{…}`
   to binary-searched range tables if it is not already.
3. The 6 emoji-sequence rows are a DIFFERENT feature (`RGI_Emoji…` string
   properties, `v`-flag territory) — do not conflate; split out if the range
   fix lands without them.

## Acceptance

- Re-run the full 311 through the real worker (the #3541 method —
  `.tmp/drive-worker.mjs` + `.tmp/pe-all.txt` in the fable-2860 worktree)
  and report the REAL flip count. Target: the 304 step-limit rows pass.
- No step-limit regressions on existing passing RegExp rows (the limit
  exists as a runaway-backtracking guard — keep pathological cases bounded).
