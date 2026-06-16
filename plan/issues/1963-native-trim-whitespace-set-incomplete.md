---
id: 1963
title: "nativeStrings trim/trimStart/trimEnd whitespace set incomplete (U+1680, U+2000-200A, U+2028/29, U+202F, U+205F, U+3000 not trimmed)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: string-methods
goal: standalone-mode
origin: "2026-06-10 deep-audit sweep (strings agent): verified miscompile on main, native backend"
---

# #1963 — native `__str_isWhitespace` misses most Unicode whitespace

## Problem

`" x".trim()`, `"　x".trim()`, `" x".trim()` keep length 2 in
native mode (node and jsHost: 1).

## Root cause

`src/codegen/native-strings.ts:2584-2613` `__str_isWhitespace` checks only
`09-0D, 20, A0, FEFF`, missing `1680, 2000-200A, 2028, 2029, 202F, 205F,
3000`. The full correct table already exists in the same repo at
`src/codegen/regex/parse.ts:59-70` (`SPACE`).

## Fix direction

Copy the `SPACE` range list from regex/parse.ts into `__str_isWhitespace`
(or share a single generated table).

## Acceptance criteria

- All three repros trim to length 1 in native mode
- ASCII fast path unchanged

## Resolution

Extended `__str_isWhitespace` in `src/codegen/native-strings.ts` to the full
§22.1.3.32 WhiteSpace + LineTerminator set: added `0x1680`, `0x2000-0x200A`,
`0x2028`, `0x2029`, `0x202F`, `0x205F`, `0x3000` to the existing
`0x09-0x0D / 0x20 / 0xA0 / 0xFEFF`. The membership test is built from small
`eq()`/`range()` helpers OR-ed together (ASCII forms first so the common case
folds cheaply). `__str_trim`/`trimStart`/`trimEnd` all share this helper, so the
fix covers all three. ASCII fast path is unchanged.

## Test Results

`tests/issue-1963.test.ts` — 16 fast-mode cases (one per added whitespace code
unit + a mixed run + non-whitespace controls + trimStart/trimEnd), all trim to
the expected length matching Node. `tests/native-strings.test.ts`: 86/86 still
pass.

## Dupe check

No hit for trim/whitespace in plan/issues.
