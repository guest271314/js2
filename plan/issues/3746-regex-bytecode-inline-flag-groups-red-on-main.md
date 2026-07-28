---
id: 3746
title: "~40 tests red on main across 4 suites, in no required check — inline regex flag groups and RegExp.prototype accessors"
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

## Shape of the regex failures

The failing cases are concentrated in **inline flag groups**:

```
/(?i:[a-c])x/ on "Bx"        /(?s:.)/ on "\n"
/(?i:(?-i:a)b)/ on "aB"      /(?m:^b)/ on "a\nb"
/(?im-s:a.b)/s on "AxB"      /a(?-i:b)c/i on "aBc"
```

i.e. scoped flag modifiers (`(?i:…)`, `(?-i:…)`, `(?s:…)`, `(?m:…)`) — the
bytecode compiler appears not to scope a flag change to its group. `#2175`'s
three are different: `RegExp.prototype` flag-bool / `.flags` / `.source`
accessor dispatch on a correct `this`.

## Scope

- [ ] Fix the inline-flag-group scoping in the regex bytecode compiler
      (`regex-bytecode` + `#1911`, 37 of the ~40).
- [ ] Fix or re-pin the three `#2175` accessor-dispatch cases.
- [ ] Triage `#1817`'s three `>>>` cases separately — different family.
- [ ] **The class fix**: decide which of these suites belong in a required
      check. Fixing 40 tests while leaving the visibility gap open means the
      next 40 are equally invisible.

## Acceptance criteria

- [ ] The four suites pass on `main`.
- [ ] At least the regex suites are wired into a required check, or an explicit
      decision is recorded for why not.
