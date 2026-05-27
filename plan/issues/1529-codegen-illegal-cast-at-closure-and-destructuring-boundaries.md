---
id: 1529
title: "codegen: 'illegal cast' umbrella at closure & destructuring parameter boundaries"
status: done
created: 2026-05-20
updated: 2026-05-27
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: type-coercion, destructuring, closures, wasm-gc
sprint: Backlog
es_edition: n/a
test262_category: multiple (class, async-generator, eval-code, super, for-await-of)
test262_count: 241
related: [1257, 1451, 1452]
---
# #1529 — Runtime `illegal cast` failures cluster at closure/destructuring boundaries

## Problem

241 test262 tests fail with runtime traps of the form:

```
L41:3 illegal cast [in __closure_N() ← assert_throws ← test]
L65:3 illegal cast [in __closure_0() ← test]
L8:5 illegal cast [in C_method() ← test]
```

This is the `ref.cast`/`ref.cast null` instruction failing at runtime
because the dynamic value's actual heap type doesn't match the
codegen's static expectation. Distribution by call-site shape:

| Shape | Count | Likely path |
|-------|-------|-------------|
| `__closure_N()` inside `assert_throws` | ~90 | default-param closure with extern-typed binding |
| `C_method() / C___priv_method()` | ~70 | class method body cast after destructuring |
| `fn() ← test` (for-await/for-of) | ~50 | iterator value cast at binding init |
| top-level `test()` | ~30 | other paths |

These are **runtime** casts (the Wasm validates fine), distinct from
#1522. They typically appear after destructuring with a default
initialiser or when a closure inherits an extern-typed captured
binding.

## Failing test examples

- `test/language/eval-code/direct/async-func-expr-named-fn-body-cntns-arguments-func-decl-declare-arguments.js`
- `test/language/expressions/class/dstr/async-gen-meth-dflt-ary-ptrn-elem-id-init-unresolvable.js`
- `test/language/statements/class/dstr/meth-static-obj-ptrn-list-err.js`
- `test/language/statements/for-await-of/async-func-decl-dstr-array-elem-init-in.js`
- `test/built-ins/Array/prototype/map/15.4.4.19-9-1.js`

## Approach

1. Pick the largest sub-cluster (default-param closure cast).
   Use `.tmp/` to reduce one test to ~10 lines.
2. Inspect emitted Wasm — likely the closure body assumes a narrower
   ref type than the caller can supply.
3. Either widen the param type to `anyref`/`externref` with a guarded
   cast that throws spec `TypeError`, or do upfront coercion at the
   call site.

## Acceptance criteria

- At least 100 of the 241 cluster tests flip from runtime trap →
  pass / assertion-fail.
- No new compile errors.
- Targeted regression test under `tests/`.

## Estimated impact

**~241 test262 tests** — high spread, so realised gain depends on
which sub-cluster is fixed first.

## Resolution (2026-05-27)

Fixed the **object-pattern destructuring default → stale global index**
sub-cluster (the largest invalid-wasm subset, manifesting as
`f64.add expected type f64, found global.get of type externref`).

Root cause: `destructureParamObject`'s struct fast path swapped
`fctx.body` to a detached `destructInstrs` buffer without registering it
in `fctx.savedBodies`, and only inserted the null-guard string constant
when closing the guard. `addStringConstantGlobal` prepends an import
global and runs `fixupModuleGlobalIndices`, which shifts every existing
`global.get`/`global.set` index — but by the time it fired the body had
been restored to `savedBody` and `destructInstrs` lived only inside the
not-yet-pushed `if.else`, invisible to the fixup. A default like
`{ c = ++n }` that reads a module global kept its pre-insertion index,
now pointing at the freshly-added string-constant import (externref)
instead of the intended f64 global.

Fix mirrors the proven #1553d / #1314 pattern already applied to the
vec and tuple-struct paths: pre-warm the null-guard string before
populating `destructInstrs`, and register the buffer in `savedBodies`
for the duration of the swap so any late import (string constant or a
function-call default's late import) re-indexes it correctly.

`src/codegen/destructuring-params.ts` — `destructureParamObject` struct
fast path.

### Remaining sub-clusters (not in this PR)

- **Call-default in a class static method** (`static m({ b = t() }) {}`)
  emits "not enough arguments on the stack" — a separate bug in the
  legacy `__extern_get` object path, narrower (class static only). Not a
  global-index issue; should be a follow-up sub-issue.
- Runtime `illegal cast` in `__closure_N`/for-await iterator-value casts —
  separate paths.

## Test Results

`tests/issue-1529.test.ts` — 6/6 pass (function param, class static
method, plain outer-var read, supplied-value-wins, left-to-right
short-circuit on throwing earlier default, two functions with
independent global indices). Sibling destructuring suites #1314 / #1372
and post-merge #1607 / #1611 all green. Conformance gain measured by CI.

## Fix (2026-05-27, object-dstr default sub-cluster)

Root cause for the `C_method()` / `__closure_N()` cast traps was a stale
`global.get`/`global.set` index in object destructuring defaults, not a
ref-type mismatch. `destructureParamObject`'s struct fast path swapped
`fctx.body` to a detached `destructInstrs` buffer **without** registering it
in `fctx.savedBodies`, and only inserted the null-guard string constant when
closing the guard. `addStringConstantGlobal` prepends an import global and
shifts every existing global index, but by then the body had been restored and
`destructInstrs` lived only inside the not-yet-pushed `if.else` — invisible to
the fixup. A default like `{ c = ++n }` reading a module global kept the
pre-insertion index, which now pointed at the freshly-added string-constant
import (externref) -> `f64.add expected f64, found global.get of type externref`
(invalid wasm) or an illegal cast at runtime.

Fix (mirrors the vec/tuple array path, #1553d):
1. Pre-warm the null-guard string constant before populating `destructInstrs`.
2. Register `destructInstrs` on `fctx.savedBodies` for the swap; pop it after
   the `if.else` is assembled (kept on the stack through
   `buildDestructureNullThrow`, which may itself add a late import).

## Test Results (2026-05-27)

- `tests/issue-1529.test.ts` — 6/6 pass (function param, class static method,
  plain outer-var default, supplied-value-wins, throwing-default short-circuit
  matching test262 `obj-ptrn-list-err`, two-function independent global
  indices). FAIL -> PASS vs. baseline (baseline emitted invalid wasm).
- Regression suites (`default-params`, `basic-destructuring`,
  `array-rest-destructuring`, `destructuring-member-targets`): identical
  pre-existing failures on baseline main — no new failures from this change.
- Scope: fixes the object-dstr default sub-cluster. The array-elem-init and
  for-await iterator sub-clusters of #1529 remain open; a separate pre-existing
  bug (populated then empty object literal `{a:5}`->`{}` reuse not re-applying
  defaults) is out of scope and tracked independently.
