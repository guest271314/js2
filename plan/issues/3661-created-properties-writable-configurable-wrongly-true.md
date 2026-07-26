---
id: 3661
title: "Created properties report writable/configurable TRUE when the spec requires FALSE (202 + 134 tests)"
status: ready
sprint: current
created: 2026-07-26
updated: 2026-07-26
priority: high
horizon: m
complexity: M
feasibility: medium
task_type: bugfix
area: codegen, runtime
language_feature: property-descriptors
es_edition: es5
goal: es5
related: [3647, 3662, 3663, 739, 3603]
origin: "2026-07-26 lead measurement of the #3603 host de-inflation regression set (merge_group run 30179758665), decomposed per failed assertion."
---

# #3661 — created properties report `writable`/`configurable` TRUE when the spec requires FALSE

## Measured population

Computed from the #3603 de-inflation merged report (`test262-results-merged.jsonl`,
merge_group run `30179758665`) diffed against the baseline JSONL. The
reconstruction totals **exactly 1,066**, matching the gate, so the regression set
is correct.

Decomposing each failure message into its individual failed assertions:

| defect kind                     | tests affected |
| ------------------------------- | -------------: |
| `enumerable` wrongly TRUE       |        838 → **#3647** |
| **`writable` wrongly TRUE**     |        **202** |
| descriptor **value** wrong      |        153 → **#3662** |
| **`configurable` wrongly TRUE** |        **134** |
| `configurable` wrongly FALSE    |         72 → **#3663** |
| `writable` wrongly FALSE        |         16 → **#3663** |

A test can fail several assertions, so these overlap. **This issue owns the two
"wrongly TRUE" rows: 202 + 134.**

## The defect

`verifyProperty` reads the descriptor back and finds `writable: true` /
`configurable: true` where the spec requires `false`. The two most likely
mechanisms, which must be distinguished before fixing:

1. **Creation defaults.** A property created by class-member definition or by
   `Object.defineProperty` with the attribute **omitted** must default to
   `false`. If we default to `true` (or leave a struct field's natural
   mutability showing through), every such property reports wrongly.
2. **Descriptor read-back.** The property is created correctly but
   `getOwnPropertyDescriptor` synthesises the attributes rather than reporting
   the stored ones.

These have completely different fixes. **Probe both before choosing** — the
sibling issue #3647 turned out to be a read-back contradiction
(`propertyIsEnumerable` disagreeing with `gOPD`), not a creation bug, and
assuming symmetry here would be exactly the mistake this project keeps making.

## Where it lives

The `enumerable` cluster (#3647) is 695/838 in class bodies. **Re-derive the
path spread for these two rows specifically** rather than assuming it matches —
the whole point of splitting these issues is that they may not share a site.

## Acceptance

- [ ] Distinguish mechanism (1) from (2) by direct probe on HEAD, recorded in
      this issue.
- [ ] Fix, with a regression test that goes **red on the merge base**.
- [ ] Report the **measured flip count** from a re-run, with its denominator.

## ⚠️ Do not quote 202 or 134 as a flip count

These are **floors for tests that fail on this assertion**, not a forecast of
tests that will flip. A test failing on `writable` may also be blocked by
something else once that is fixed. Only a re-run measures the true number.

## ⚠️ This area's history of vacuous evidence

Three separate probes in this exact surface produced artifacts in one session
(2026-07-25/26):

- The ES5 census's §2.2 "probe-confirmed" A2 row recorded a defect that **does
  not exist** — its probe read `'x' in o` after a `delete` that **throws**, so
  the expression never evaluated.
- Its A1 row had the **direction inverted**: over-restriction dominates, not
  under-enforcement — which the table above independently confirms (202 wrongly
  TRUE against 16 wrongly FALSE for `writable`, but 134 vs 72 for
  `configurable`, so the picture is attribute-specific).
- `verifyProperty` itself reported pass for **any** expectation until #3603
  landed.

**Verify any green against a known-failing control**, and make sure no assertion
in your probe can throw before the value you are reading is evaluated.

## Provenance caveat

The baseline used was the then-current cache, not the exact artifact the gate
read (#3648 — the gate clones the baselines repo at step time). The total
matching 1,066 exactly means the regression **set** is right; individual counts
may shift by a few.
