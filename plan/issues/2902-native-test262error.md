---
id: 2902
title: "Standalone: native Test262Error construction eliminates env::__new_Test262Error host-import leak (~2,779 tests)"
status: done
created: 2026-06-30
completed: 2026-06-30
updated: 2026-07-03
assignee: ttraenkler/sendev-error
priority: high
feasibility: hard
task_type: feature
area: codegen
goal: standalone
sprint: 69
horizon: m
related: [1104, 1536, 2188, 2862]
---

# Standalone: native Test262Error construction (eliminate `__new_Test262Error` leak)

## Problem

The test262 harness (`wrapTest`, `tests/test262-runner.ts:1536`) injects
`class Test262Error { message }` into every wrapped test, and the test body
contains `throw new Test262Error(...)` on its failure path. `Test262Error` is
listed in `KNOWN_CONSTRUCTORS` (`src/codegen/index.ts`) and intercepted in the
Error-constructor branch of `compileNewExpression`
(`src/codegen/expressions/new-super.ts`). Because `Test262Error` is **not** in
`WASI_ERROR_NAMES`, that branch fell through to a `__new_Test262Error` **host
import** even in `--target standalone` / `--target wasi`, where there is no JS
host to satisfy it.

A leak-analysis of the merge_group standalone report (2026-06-30) found
**~2,779 tests import ONLY `env::__new_Test262Error`**. These tests *pass* —
they never reach the `throw` — so the import is dead weight that nonetheless
keeps the module out of host-free. Fixing this one lowering flips ~2,779 tests
host-free and removes a co-blocker on thousands of exception-touching tests.

## Root cause (verified on current main)

`new-super.ts` Error branch: `(ctx.wasi || ctx.standalone) && isWasiErrorName(ctorName)`
builds an in-module `$Error_struct`; otherwise it calls
`ensureLateImport("__new_Test262Error", ...)`. `isWasiErrorName("Test262Error")`
is `false`, so standalone always took the host-import path.

Measured (standalone, current main, via `wrapTest` + `compile({target:"standalone"})`):
`test262/test/language/types/boolean/S8.3_A1_T1.js` and
`.../expressions/addition/S11.6.1_A1.js` each leaked exactly `[__new_Test262Error]`.
A 250-file stride sample: 15 leak ONLY `__new_Test262Error`, 16 leak it + others.

## Fix

In standalone/WASI mode, lower `new Test262Error(msg)` to an in-module
`$Error_struct` — the *same* struct the WASI error constructors use — tagged as
`Error` (`BUILTIN_TYPE_TAGS.Error`, so `instanceof Error` holds, matching the
harness's `Test262Error extends Error`) with `$name` = `"Test262Error"`.

- `src/codegen/registry/error-types.ts`: extracted the shared
  `emitErrorStructConstructor(ctx, importName, displayName, tagValue, argCount)`
  body out of `emitWasiErrorConstructor` (byte-identical struct shape); added
  `emitStandaloneTest262Error(ctx, argCount)` that calls it with name
  `"Test262Error"` and the `Error` tag.
- `src/codegen/expressions/new-super.ts`: after the `isWasiErrorName` branch,
  added a sibling `(ctx.wasi || ctx.standalone) && ctorName === "Test262Error"`
  branch that emits the native constructor and calls it, returning before the
  `ensureLateImport` host-import path.

**JS-host mode is deliberately unchanged** — it keeps the `__new_Test262Error`
host import (a real `Error` subclass) so message serialization across the wasm
boundary is unaffected. This follows the dual-mode principle (host fast path +
standalone-native fallback).

### Why tag = `Error` (not a new builtin tag)

Giving `Test262Error` the `Error` tag (rather than registering it in
`BUILTIN_TYPE_TAGS`, which would make `isBuiltinTypeName` true everywhere and
widen blast radius) makes `instanceof Error` true while keeping `.name` =
`"Test262Error"` via the `$name` field. `Test262Error` is conceptually an Error
subclass, so this is the most faithful and lowest-surprise representation.

## Verification

- Standalone throw/catch (`.tmp` probe + `tests/issue-2902.test.ts`): a thrown
  `Test262Error` yields correct `.message` (`"boom"`), `.name`
  (`"Test262Error"`), and `instanceof Error` (true) — score 7/7. Module is
  host-free (`imports == []`).
- 250-file standalone survey after the fix: "leak ONLY `__new_Test262Error`"
  15 → 0; host-free 74 → 89 (+15); all co-leaked `Test262Error` imports removed
  (16 → 0). Compile-error count unchanged (8 → 8).
- JS-host mode: `__new_Test262Error` import still present (unchanged).
- `tests/issue-2902.test.ts` (7 cases, standalone+wasi+host) pass.
- Regression batch (60 tests): `issue-1104-phase1/2/3`, `issue-1536`,
  `issue-1536c`, `error-reporting-catchpaths` all green.
- The 3 pre-existing `error-reporting.test.ts` failures (`with`/`eval` compile
  line numbers) reproduce on clean `origin/main` — unrelated to this change.

The full merge_group standalone report is the corpus arbiter (must be a large
NET-POSITIVE with zero regression to throw/catch/message/instanceof paths).
