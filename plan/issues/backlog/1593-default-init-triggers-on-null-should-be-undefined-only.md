---
id: 1593
title: "Destructuring default initializer triggers on null — spec requires undefined-only check (~165 fails)"
status: backlog
created: 2026-05-24
updated: 2026-05-24
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: destructuring, default-initializer, for-of, for-await-of, classes
goal: spec-completeness
sprint: Backlog
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
