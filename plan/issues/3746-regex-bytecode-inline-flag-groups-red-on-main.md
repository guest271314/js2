---
id: 3746
title: "~40 tests red on main in no required check — 37 were the HOST oracle, not our lowering (ES2025 regexp-modifiers postdate Node 22)"
status: ready
sprint: current
created: 2026-07-28
updated: 2026-07-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: regexp
goal: core-semantics
related: [1911, 2175, 1817, 3726]
origin: "bisected against clean upstream/main during #3705/#3739 work, 2026-07-28"
---

# #3746 — ~40 tests red on `main`, invisible

## The finding

Bisected against a clean `upstream/main` worktree while verifying unrelated
work. Every one of these fails **identically with and without** the changes
under test, i.e. they are red on `main` itself:

| suite                                           | failing |
| ----------------------------------------------- | ------: |
| `tests/regex-bytecode.test.ts`                  |      20 |
| `tests/issue-1911-regex-phase2d.test.ts`        |      17 |
| `tests/issue-2175-regexp-proto-readers.test.ts` |       3 |
| `tests/issue-1817.test.ts`                      |       3 |

The first three are regex; `#1817` is the `>>>` unsigned-result family.

## Why nobody was told

None of these suites is in a required check. This is the same structural gap
that let the four suites #3705 fixed sit red on `main` — and #3726 recorded the
lesson for the two it touched. It has not been fixed as a class: a suite that is
not in a required check can go red on `main` and stay there indefinitely.

## CORRECTED — 37 of the 40 were never our bug

The failing patterns are inline modifiers (`(?i:…)`, `(?-i:…)`, `(?s:…)`,
`(?m:…)`) — ES2025 **regexp-modifiers**. Both suites use the HOST `RegExp` as
their ORACLE:

```ts
const expected = new RegExp(p, f).test(input); // issue-1911
expect(ourMatch(p, f, input)).toEqual(nativeMatch(p, f, input)); // regex-bytecode
```

and V8 gained modifiers after Node 22. On this runtime:

```
node v22.22.2
new RegExp("(?i:abc)")  →  Invalid regular expression: /(?i:abc)/: Invalid group
```

So the exception came from the ORACLE constructing its expectation, before our
pipeline was consulted at all. The error text in the failure output —
`Invalid regular expression: … Invalid group` — is node's own, which is what
gave it away.

Nothing was wrong with the regex bytecode compiler's flag-group scoping. My
first reading of this issue asserted exactly that, from the pattern shapes
alone, without checking who threw.

## Fix

Ask the engine whether it supports modifiers and skip those cases when it does
not:

```ts
const HOST_SUPPORTS_INLINE_MODIFIERS = (() => {
  try {
    new RegExp("(?i:a)");
    return true;
  } catch {
    return false;
  }
})();
```

Skipped rather than deleted: the cases are correct and become live the moment
the runtime gains modifiers. A hard-coded version check would rot; asking the
engine is the durable form of the question.

Result: `regex-bytecode` 258 passed / 20 skipped; `issue-1911` 70 passed /
17 skipped. Both green.

## Still open

- [ ] `tests/issue-2175-regexp-proto-readers.test.ts` — 3 failures,
      `RegExp.prototype` flag-bool / `.flags` / `.source` accessor dispatch on a
      correct `this`. A different family; not host-oracle, genuinely ours.
- [ ] `tests/issue-1817.test.ts` — 3 failures in the `>>>` unsigned-result
      family. Different again.
- [ ] **The class fix.** None of these suites is in a required check, which is
      why ~40 red tests sat on `main` unnoticed — the same structural gap that
      let the four suites #3705 fixed go unreported, and that #3726 recorded the
      lesson for. Fixing the tests while leaving the gap open means the next
      batch is equally invisible. Decide which of these belong in a required
      check.

## Acceptance criteria

- [x] `regex-bytecode` and `issue-1911` pass on `main`.
- [ ] `issue-2175`'s three accessor cases fixed or re-pinned.
- [ ] `issue-1817`'s three `>>>` cases triaged.
- [ ] A decision recorded on required-check coverage for these suites.
