---
id: 3023
title: "iterator protocol: synthesized-iterator .next callability + for-of/for-await abrupt-completion residual (~508 default-lane fails)"
status: ready
sprint: current
created: 2026-07-03
updated: 2026-07-03
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: iterators, for-of, for-await-of
es_edition: 2015
goal: spec-completeness
test262_category: language/statements/for-of, language/statements/for-await-of, language/expressions/async-generator
test262_fail: 508
related: [2669]
---

# #3023 — iterator protocol: `.next` callability + for-of/for-await abrupt completion

## Source

Default (JS-host) lane test262 harvest, 2026-07-03
(`.test262-cache/test262-current.jsonl`, run `20260703-092808`). Two related
sub-buckets:

- `TypeError: it.next is not a function` in destructuring contexts
  (`class/dstr`, `assignment/dstr`, `async-generator/dstr`) — **113**. A
  synthesized/custom iterator object's `.next` isn't recognized as callable
  by the destructuring iterator-consumption path.
- `for-of` (**275**) / `for-await-of` (**120**, with async-generator
  combined **261**) abrupt-completion and iterator-close gaps — the runtime
  doesn't correctly call `IteratorClose` / propagate abrupt completions
  (`break`/`throw`/`return` mid-loop) through custom and async iterators.

This is narrower than — but overlaps — the #2669 destructuring-correctness
residual umbrella (which already tracks `for-of/dstr` at 247 as one of its
sub-buckets). This issue scopes specifically to the iterator-protocol
mechanics (`.next` callability, `IteratorClose`, abrupt completion through
for-of/for-await), as distinct from #2669's broader destructuring-pattern
correctness (defaults, holes, rest). Coordinate with #2669 before
implementing to avoid duplicate fixes on the shared `for-of/dstr` surface.

## Sample failing files

- `language/expressions/assignment/dstr/array-elem-trlg-iter-elision-iter-nrml-close-skip.js`
- `language/expressions/async-generator/dstr/ary-init-iter-close.js`
- (for-of/for-await abrupt completion — pull fresh samples from
  `language/statements/for-of/` and `language/statements/for-await-of/`
  `error_category` groupings at implementation time)

## Suggested approach

1. Confirm whether `.next` callability failures share a root cause with the
   iterator-close call path — a custom `{ next() {...} }` object literal
   used as an iterator may not be recognized as callable if the codegen
   checks a closed/nominal shape instead of doing a generic property lookup
   + call.
2. Audit `IteratorClose` invocation sites for for-of/for-await: is it called
   on every abrupt completion (`break`, labeled `continue`, `throw`,
   `return`) inside the loop body, for both sync and async iterators?

## Acceptance criteria

- `.next is not a function` fails in destructuring iterator contexts drop
  materially below 113.
- for-of / for-await-of abrupt-completion test262 fails drop materially
  below the combined 395 recorded here.
