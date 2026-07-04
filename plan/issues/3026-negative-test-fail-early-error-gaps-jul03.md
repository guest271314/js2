---
id: 3026
title: "negative_test_fail: residual early-error / static-semantics gaps (~79 default-lane, 64 unenforced SyntaxErrors)"
status: ready
sprint: current
created: 2026-07-03
updated: 2026-07-03
status_note: "First slice landed (PR): trailing-comma-after-rest early error in destructuring patterns (all four forms). Issue stays open — remaining unenforced-SyntaxError samples decompose into further independent point-fixes per the issue's own triage note."
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

## Slice 1 landed — trailing comma after a rest element (2026-07-03)

**Delivered:** a precise parse-time early error for a trailing comma following
a rest element in every destructuring-pattern position — an
`AssignmentRestElement` / `BindingRestElement` / `AssignmentRestProperty` /
`BindingRestProperty` must be the final element with no trailing comma
(elision) after it:

- `[...x,] = y` (array assignment pattern) and the for-of/for-in head form
  `for ([...x,] of ...)` — covers the issue sample
  `language/statements/for-of/dstr/array-rest-elision-invalid.js`.
- `const [...x,] = y` (array binding pattern).
- `({...x,} = y)` (object assignment pattern).
- `const {...x,} = y` (object binding pattern).

**Root cause:** the pre-existing "rest must be last" check only fired when an
*element* followed the rest (`[...x, y]`); TypeScript's parser accepts the bare
trailing comma `[...x,]` silently and does NOT insert a trailing
`OmittedExpression`, so nothing detected it. Fix keys off the NodeArray's
`hasTrailingComma` flag when the last element is the rest.

**Files:** `src/compiler/early-errors/assignment.ts` (array + object assignment
patterns), `src/compiler/early-errors/node-checks.ts` (array + object binding
patterns). Tests: `tests/issue-3026.test.ts` (5 reject + 5 valid-control
cases). Byte-inert for all valid programs — spread-with-trailing-comma in an
array/object literal *value* (`const v = [...x,]`, `{...x,}`) and a trailing
comma after a non-rest element (`[a,]`, `{a,}`) all remain valid.

**Remaining:** the other unenforced-`SyntaxError` samples (private-name grammar,
`prop-def-invalid-async-prefix`, etc.) are independent point-fixes per the
issue's own triage note — issue stays open for follow-up slices.

## Slice 2 landed — `async` prefix on a shorthand property (2026-07-03)

**Delivered:** a precise parse-time early error for `async` used as the prefix
of a shorthand object property. `PropertyDefinition : IdentifierReference`
(shorthand) is a bare IdentifierReference and admits no modifier; `async` is
only valid as the prefix of an `AsyncMethod`, which requires a `(` parameter
list. Covers the issue sample
`language/expressions/object/prop-def-invalid-async-prefix.js` (`({async async})`)
and the cover-initialized-name form `({async x = 1})`.

**Root cause:** TypeScript's parser silently accepts `({async async})` /
`({async x = 1})` as a `ShorthandPropertyAssignment` carrying an `AsyncKeyword`
modifier with **no** parse diagnostic — unlike `({get x})` / `({set x})` /
`({* x})`, which it already flags. So nothing in the early-error pass detected
it. The fix checks for an `AsyncKeyword` modifier on a
`ShorthandPropertyAssignment` (the only modifier that produces this node shape
without a TS parse diagnostic).

**Files:** `src/compiler/early-errors/node-checks.ts` (one additive check next
to the existing shorthand-property checks). Tests: `tests/issue-3026.test.ts`
(+2 reject, +4 valid-control cases). Byte-inert for all valid programs —
`async` as a plain shorthand name (`({async})`), alongside other shorthands
(`({async, x})`), as an async method (`({async foo(){}})`), and as a normal key
(`({async: 1})`) all remain valid.

**Remaining:** further unenforced-`SyntaxError` samples (private-name grammar on
class heritage, `array-rest-elision-invalid` residuals, etc.) remain independent
point-fixes — issue stays open for follow-up slices.
