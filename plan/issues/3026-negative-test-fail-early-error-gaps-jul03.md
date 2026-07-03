---
id: 3026
title: "negative_test_fail: residual early-error / static-semantics gaps (~79 default-lane, 64 unenforced SyntaxErrors)"
status: ready
sprint: current
created: 2026-07-03
updated: 2026-07-03
priority: medium
horizon: s
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: parser
language_feature: early-errors, static-semantics
goal: spec-completeness
test262_category: language/expressions/class/elements/syntax/early-errors, language/statements/for-of/dstr, language/expressions/object
test262_fail: 79
related: [927, 1091, 1435, 1805, 1931, 2912, 2920]
---

# #3026 — residual negative_test_fail: early-error / static-semantics gaps

## Source

Default (JS-host) lane test262 harvest, 2026-07-03
(`.test262-cache/test262-current.jsonl`, run `20260703-092808`),
`negative_test_fail` records — tests where test262 expects an early
(parse-time) or runtime error and the compiler instead accepts/executes the
program. **79** total, a residual after a long line of prior early-error
issues (#927, #1091, #1435, #1805, #1931, #2912, #2920) each closed a wave of
these; new specific gaps keep surfacing as the parser/static-semantics
coverage grows (expected pattern for this project — not a regression).

## Breakdown

| pattern | count |
|---|--:|
| expected `SyntaxError`, compiled with no diagnostic (early error not detected) | 64 |
| expected runtime `ReferenceError` but succeeded | 9 |
| expected runtime `SyntaxError` but succeeded | 3 |
| expected resolution `SyntaxError`, no diagnostic | 2 |
| expected runtime `TypeError` but succeeded | 1 |

## Sample failing files

- `language/expressions/class/elements/syntax/early-errors/grammar-private-environment-on-class-heritage-function-expression.js`
- `language/statements/for-of/dstr/array-rest-elision-invalid.js`
- `language/expressions/object/prop-def-invalid-async-prefix.js`

## Suggested approach

Same procedure as the prior early-error issues in `related:` — for each of
the 64 unenforced-`SyntaxError` files, identify the specific static-semantics
rule (grammar-level early error, usually documented directly in the ECMA-262
production's "Early Errors" clause) and add the missing check to the
parser/semantic-analysis pass. Given the pattern of this project's prior
early-error issues, expect this to decompose into several small, unrelated
point-fixes rather than one shared root cause — triage each sample
individually before batching.

## Acceptance criteria

- `negative_test_fail` count in the default lane drops materially below 79.
- No new `negative_test_fail` regressions introduced (verify via a
  differential test262 run before/after).
