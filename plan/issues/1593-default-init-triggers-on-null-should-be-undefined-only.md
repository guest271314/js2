---
id: 1593
title: "Destructuring default initializer triggers on null — spec requires undefined-only check (~165 fails)"
status: done
created: 2026-05-24
updated: 2026-05-28
completed: 2026-05-27
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: destructuring, default-initializer, for-of, for-await-of, classes
goal: spec-completeness
sprint: 56
test262_fail: 165
test262_category: language/statements/class/dstr, language/statements/for-await-of, language/statements/for-of, language/statements/for
---
# #1593 — Destructuring default initializer triggers on `null` (spec: `=== undefined` only)

## Problem

**165 test262 failures** in `*-init-skipped` destructuring tests. These tests verify that a binding element's default initializer is **not** executed when the matched value is `null` — only when it is `undefined` (§13.3.3.1 step 5.c.ii).

### Observed errors

```
test/language/statements/class/dstr/private-gen-meth-ary-ptrn-elem-id-init-skipped.js
  returned 2 — assert #1 at L79: assert.sameValue(w, null);
  // w should be null (from iterator), not the default "foo"

test/language/statements/for-await-of/async-func-dstr-let-async-ary-ptrn-elem-id-init-skipped.js
  returned 6 — assert #5 at L64: assert.sameValue(initCount, 0);
  // the init expression ran (initCount incremented) when it shouldn't have

test/language/statements/for/dstr/var-obj-ptrn-prop-id-init-skipped.js
  returned 6 — assert #5 at L52: assert.sameValue(initCount, 0);
```

### Category breakdown (2026-05-24 run, assertion_fail)

| Category | ~Count |
|----------|--------|
| `for-await-of` | ~65 |
| `class/dstr` | ~51 |
| `for-of` | ~26 |
| `for` | ~12 |
| other | ~11 |

### Root cause

Our default-value emission generates code equivalent to:

```js
if (value == null) value = defaultExpr;  // WRONG — triggers on both null and undefined
```

The spec (§13.3.3.1 BindingElement evaluation, step 5.c):
> *If Initializer is present and v is **undefined**, …*

The check must be **strict equality** with `undefined` only:

```js
if (value === undefined) value = defaultExpr;  // CORRECT
```

In WasmGC terms, the guard should be `ref.is_null` / `extern.is_null` on an `externref` holding the JS `undefined` sentinel, **not** a general null-check that catches our Wasm-null (`null` in JS).

## Fix location

Search for the default-value guard in:
- `src/codegen/statements/destructuring.ts` — `emitDefaultValueCheck` (around line 297 per the s55 note)
- `src/codegen/statements/destructure-params.ts` — parameter binding path

The guard likely uses `ref.is_null` or a host import that checks for `null || undefined`; change it to check only for `undefined` (the JS `undefined` sentinel externref).

## Acceptance criteria

- `const [x = "default"] = [null]` → `x === null` (init skipped)
- `const [x = "default"] = [undefined]` → `x === "default"` (init runs)
- All ~165 `*-init-skipped` test262 files pass
- No regressions in existing default-initializer tests

## Notes

- Spec: ECMA-262 §13.3.3.1 BindingElement Evaluation, step 5.c.ii: "If Initializer is present and v is **undefined**"
- The `initCount` pattern in test files uses a side-effectful counter to verify the initializer body does not execute at all
- Easy fix: a one-line guard change in `emitDefaultValueCheck`, but must also verify the `destructureParamObject` / `destructureParamArray` paths use the same guard

## Resolution (2026-05-27, PR #637)

Fixed by commit e89c72eaf (`fix(#1593): coerce dstr default initializer
result to binding local type`), merged via PR #637 on 2026-05-27.

The null-vs-undefined *guard* was already correct on main —
`emitExternrefDefaultCheck` uses `__extern_is_undefined` exclusively
(landed via #1550 / #1553e), so `[null]` and `{s: null}` correctly skip
the default. The faithful test262 `init-skipped` templates
(`[null, 0, false, '']` / `{s: null, u: 0, ...}` / for-of) already
passed once reproduced exactly.

The remaining failures were a **codegen type bug**, not a guard bug: in
`emitDefaultValueCheck` (`src/codegen/statements/destructuring.ts`) the
then-branch compiled the default initializer and `local.set` its result
without coercing to the binding local's declared type. test262
init-skipped tests use a `counter()` that returns **void**
(`undefined`), which lowers to an `externref` on the stack. When the
binding local is `f64` (e.g. field `u: 0`), the `local.set` failed Wasm
validation (`local.set expected type f64, found call of type externref`)
— failing the *whole* `if/else` (and thus the test) even though the
default never fires at runtime.

Fix: a shared `emitDefaultIntoLocal` closure compiles the initializer,
maps a `VOID_RESULT` to `externref`, and coerces to
`getLocalType(localIdx)` before `local.set`. Applied to all three
branches (externref / f64 / ref).

Tests: `tests/issue-1593.test.ts` (5 cases — array / object / for-of
init-skipped + numeric-field-void-default compile +
missing-prop-triggers-default). All passing on
HEAD as of 2026-05-28.

### Status-field reconciliation (2026-05-28)

The post-merge bulk-update commit 4222350b6 (Team Lead sprint promotion,
2026-05-27 14:07) was authored against a pre-#637 snapshot of this
issue file. When merged it silently reverted PR #637's
`status: done`/`completed:` and removed this Resolution section,
reintroducing the issue as `ready` on the s56 queue. This commit
restores both. No code change is needed — the fix has been live on
main since 2026-05-27.

Out of scope (separate pre-existing bugs, still failing on main, NOT
touched by PR #637):
- single-element `[null as any]` / `[undefined as any]` value
  corruption (mixed-type array element narrowing) — distinct from
  init-skipped cluster.
- `function f(x: number = 42)` returning `0` when arg omitted
  (`default-params.test.ts`) — pre-existing param-default failure on
  main.
