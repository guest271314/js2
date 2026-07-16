---
id: 3307
title: "Standalone regression: dynamic-descriptor accessor merge illegal-cast (4 issue-2992-accessor-merge cases, passed on 026f40f771-era main)"
status: in-progress
assignee: ttraenkler/fable-mop
sprint: current
priority: high
horizon: m
feasibility: medium
task_type: fix
area: codegen, runtime
language_feature: object-property-descriptors
goal: standalone-mode
created: 2026-07-16
related: [2992, 3246, 3274]
origin: "flagged by fable-mop during #2992 slice-5 validation — pre-existing on current main, not caught by scoped CI suites"
---

# #3307 — standalone dynamic-descriptor accessor merge regressed (illegal cast)

## Problem

4 of 18 standalone cases in `tests/issue-2992-accessor-merge.test.ts` (the
#2992 slice-3 suite, 18/18 green when PR #2893/#2898 landed on 2026-07-11)
now fail on current main:

- `get-only redefine preserves the live setter (15.2.3.6-4-107 shape)` — **illegal cast**
- `flags-only redefine of an accessor preserves both halves (15.2.3.6-4-82-* shape)` — **illegal cast**
- `explicit { get: undefined, set: undefined } creates an accessor visible to gOPD (15.2.3.6-4-439)` — value mismatch (+0 !== 1)
- `non-configurable accessor rejects a getter change with TypeError` — **illegal cast**

Common shape: **dynamic descriptors** (`var d: any = { get: g, … };
Object.defineProperty(o, "foo", d)`) on a bracket-poisoned `$Object` receiver
(`o["q"] = 0`). The gc lane passes all 18; only the standalone lane regressed.

## Culprit range

`c78ac50702` (slice-4 merge, 18/18 pass) .. `503b64ac35` (4 fail; also fails
at `a83f59a27f` #3246 and at current `7e9d22a66e`). 205 first-parent commits;
bisect in progress — culprit recorded below when found.

## Repro

```bash
npx vitest run tests/issue-2992-accessor-merge.test.ts   # 4 standalone fails
```

Not caught by CI: the `quality` gate runs scoped vitest suites only, and the
test262 baseline gates key on test262 files, not this unit suite.

## Acceptance

- `tests/issue-2992-accessor-merge.test.ts` back to 18/18 (gc + standalone).
- No regressions on the #2992 sibling suites (`issue-2992.test.ts`,
  `issue-2992-delete-widening.test.ts`, `issue-2992-accessor-widening.test.ts`)
  and a defineProperty/defineProperties standalone spot-sample.
