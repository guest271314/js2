---
id: 1740
title: "String.prototype.padStart/padEnd omitted fillString defaults to 'null' instead of space"
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
sprint: 57
related: [1739]
---
# #1740 — padStart/padEnd default fillString must be a space

## Problem

`'abc'.padStart(6)` (fillString omitted) returned `"nulabc"` instead of
`"   abc"`. Per §22.1.3.17 StringPad, when `fillString` is `undefined` it is
set to `" "` (a single space).

In JS-host mode the string-method dispatch (`src/codegen/expressions/calls.ts`)
padded the missing `fillString` externref argument with `ref.null.extern`, so
the host `string_padStart` received JS `null`, which ToString-coerces to
`"null"` → the pad used "nul"/"null".

## Fix

`padStart`/`padEnd` added to the `padsUndefined` set in `calls.ts` (alongside
`endsWith`/`lastIndexOf`), so the omitted pad arg is passed as JS `undefined`
(via `__get_undefined`). The host then calls `s.padStart(n)` and the native JS
spec default `" "` applies.

## Test Results

`tests/issue-1740.test.ts` — 6 cases pass:
- `'abc'.padStart(6)` → `"   abc"`, `'abc'.padEnd(6)` → `"abc   "`
- explicit fill unchanged (`'x'.padStart(4,'12')` → `"121x"`)
- target ≤ length returns unchanged
- multi-char fill truncates (`'abc'.padStart(7,'def')` → `"defdabc"`)

test262 `built-ins/String/prototype/padStart` and `padEnd` each go 6→7
runtime-pass locally (the `fill-string-omitted` + `normal-operation` cases).
No regression in `endsWith`/`lastIndexOf` (share the same branch).

The remaining padStart/padEnd test262 failures are TS-type-check CEs from
intentionally wrong-typed args (symbol/boolean) — tracked under #1741.

## Files modified

- `src/codegen/expressions/calls.ts` — add padStart/padEnd to `padsUndefined`.
- `tests/issue-1740.test.ts` — new.
