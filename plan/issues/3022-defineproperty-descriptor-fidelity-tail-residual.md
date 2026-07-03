---
id: 3022
title: "spec gap: Object.defineProperty(ies) descriptor fidelity tail + non-object receiver arm (~728 default-lane fails)"
status: ready
sprint: current
created: 2026-07-03
updated: 2026-07-03
priority: high
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: object-defineproperty, property-descriptors
es_edition: 5
goal: spec-completeness
test262_category: built-ins/Object/defineProperty, built-ins/Object/defineProperties
test262_fail: 728
related: [1334, 1629, 1629a, 1631]
---

# #3022 — Object.defineProperty(ies): descriptor fidelity tail + non-object receiver

## Source

Default (JS-host) lane test262 harvest, 2026-07-03
(`.test262-cache/test262-current.jsonl`, run `20260703-092808`). Two
sub-buckets:

- `built-ins/Object/defineProperties` + `defineProperty` descriptor
  assertion failures — **600**.
- `TypeError: called on non-object` / "called on non-object" assertion
  failures — **128** — the non-object-receiver arm of `Object.defineProperty`
  and related built-ins (should throw, or should coerce, per spec) is not
  handled.

## Problem

#1334/#1629 ("biggest single bucket", 664 fails at the time) landed the bulk
of descriptor-attribute fidelity, and #1629a/#1631 covered dynamic
(non-literal) descriptor materialization and `Object.create` descriptor maps.
A tail of **600** descriptor-fidelity fails remains — likely rarer descriptor
shapes (getter/setter combined with data-descriptor transitions,
non-configurable → configurable illegal transitions, array `length`
interaction) not covered by the original fix's test corpus. Separately, a
**128**-fail cluster hits `TypeError: called on non-object` where the receiver
of a property-descriptor operation is a primitive — this arm looks entirely
unhandled (should follow `ToObject`/throw semantics per the relevant spec
clause for each built-in, not a blanket internal error).

## Sample failing files

- `built-ins/Object/defineProperties/15.2.3.7-5-b-218.js`
- `built-ins/Object/defineProperties/15.2.3.7-2-16.js`
- `built-ins/JSON/parse/reviver-array-non-configurable-prop-delete.js` (non-object arm)

## Suggested approach

1. Diff the 600 tail fails against the #1334/#1629 test corpus at the time
   those issues closed — identify which descriptor-transition rules
   (8.[6|9|10] `ValidateAndApplyPropertyDescriptor` steps) are still
   unimplemented vs. which are implemented-but-buggy.
2. For the 128 non-object-receiver cluster, find the shared call path (likely
   in the runtime helper backing `Object.defineProperty`/`defineProperties`/
   related reflective ops) and add the missing receiver-type check per spec
   (most should `TypeError` on non-object, matching the "called on
   non-object" test names — verify against `Object.defineProperty` \S15.2.3.6
   step 1).

## Acceptance criteria

- Descriptor-fidelity fail count in `built-ins/Object/defineProperty{,ies}`
  drops materially below the 600 recorded here.
- Non-object receivers to `Object.defineProperty`/`defineProperties`
  produce spec-correct `TypeError`s instead of an internal/vague error.
