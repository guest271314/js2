---
id: 1731
title: "String.prototype.substring()/slice() with no args returns '' instead of the whole string"
status: done
created: 2026-05-29
updated: 2026-05-29
completed: 2026-05-29
priority: medium
feasibility: easy
task_type: bugfix
area: codegen
language_feature: string-methods
goal: test262-conformance
sprint: Backlog
es_edition: 2015
related: [1248]
---
# #1731 — substring()/slice() with no args returns "" (missing-end length default)

## Problem

`"hello".substring()` and `"hello".slice()` (no arguments) return `""` instead
of the whole string `"hello"`.

Per ECMA-262 §22.1.3.24 (`String.prototype.substring(start, end)`) the missing
`end` defaults to the string length (`len`), and missing `start` →
ToIntegerOrInfinity(undefined) = 0; §22.1.3.21 (`slice`) is analogous. So a
no-arg call must return the entire string.

## Root cause

`compileCallExpression` string-method path in
`src/codegen/expressions/calls.ts` (~6790). The #1248 "default missing `end`
to `s.length`" logic (`needsLengthDefault`) only fired for **`args.length ===
1`**. For the **no-arg** case it never triggered, so the generic
argument-padding loop pushed `f64.const 0` for *both* the missing `start` and
the missing `end` → the host import called `s.substring(0, 0)` → `""`.

## Fix

Widen the `needsLengthDefault` guard from `args.length === 1` to
`args.length <= 1`. The pad loop's existing `pi === 2` branch then supplies
`s.length` for the missing `end`, and the missing `start` (`pi === 1`) keeps
its correct `0` default. One-arg, two-arg, and substring's swapped-arg paths
are unchanged.

## Acceptance criteria

- `"hello".substring()` / `"hello".slice()` return `"hello"`.
- `"".substring()` / `"".slice()` return `""`.
- No regression in the single-arg (#1248), two-arg, or swapped-arg cases.

## Test Results

`tests/issue-substring-noarg.test.ts` — 5 cases (no-arg substring/slice, empty
string, single-arg #1248 regression guard, two-arg + swapped-arg guard). All
pass. `prettier --check` clean.

Localized one-line guard change. Found via the #259 conformance-triage of the
`built-ins/String/prototype/{substring,slice}` FAIL clusters
(`S15.5.4.{13,15}_A1*` value-semantics tests).
