---
id: 2801
title: "[SENIOR-DEV ONLY] compiled-acorn CallExpression `arguments` marshals as `{}` not an array (host vec→array gap)"
status: in-progress
assignee: ttraenkler/sendev-acorn-callargs
sprint: current
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
created: 2026-06-28
updated: 2026-06-28
task_type: bugfix
area: codegen
language_feature: value-representation
goal: acorn-dogfood
related: [2794, 2784, 2664, 2674]
depends_on: [2794]
blocks: []
---

# #2801 — compiled-acorn CallExpression `arguments` marshals as `{}` not an array

**Carved out of #2794.** Compiled acorn parses a call expression to the right
top-level shape, but the `arguments` array of the `CallExpression` node comes
back to the host as an **empty object `{}`** instead of a JS array of argument
nodes — so the parsed AST is wrong/incomplete. A parser that returns
`CallExpression` with empty `arguments` is not correct, so this blocks the
"make acorn work" goal.

## Symptom (observed during #2794)

Differential diff (dogfood `diffAst`, positions ignored) of compiled-acorn vs
node-acorn for `foo(bar, baz)`:

```
$.body[0].expression.callee.sourceFile  → extra-field   (benign marshaling noise)
$.body[0].expression.arguments          → array-vs-object  expected [Array(2)] actual {}
```

So `CallExpression.arguments` is `{}` (an empty object) where node-acorn has
`[Identifier(bar), Identifier(baz)]`. The call's `callee` (an Identifier) is
correct; only the `arguments` collection is wrong.

## Likely mechanism (verify-first)

`arguments` is an array field on the `CallExpression` node — a WasmGC **vec**
(or a plain-array struct) holding the argument nodes. When the host reads it
through the `_wrapForHost` proxy / `wrapExports` AST walk, a vec field should be
materialized into a real JS array (via `__vec_len`/`__vec_get`, cf.
`_materializeIterable` in `src/runtime.ts`). It is instead surfacing as `{}` —
an empty object proxy. Candidate causes to pin (instrument, don't guess):

- the `arguments` field's value is NOT recognized as a vec by `__is_vec` (so the
  vec→array materialization path is skipped and it falls to a generic object
  proxy → `{}`); OR
- it IS a vec but `wrapExports`'s recursive node-graph conversion doesn't
  descend into / materialize this particular field (the AST walk reads it as an
  opaque struct → `{}`); OR
- the `arguments` array was built empty / not populated for an `any`-typed
  parse path (parser stored args into a different vec instance — an S3-class
  vec-identity split, cf. #2784); OR
- interaction with the **#2794 `__is_data_struct` change** — verify the
  `arguments` vec is not now being diverted to `_wrapForHost` (object) by the
  new positive-data-struct gate. (The gate only fires AFTER the `__is_vec`
  guard, so a genuine vec should be unaffected — but confirm `__is_vec(args)===1`
  for this field. If the `arguments` value is a *plain-array struct* rather than
  a vec, `__is_vec` returns 0 and the data-struct gate would wrap it as an
  object — that would be the regression-adjacent root cause and the fix is to
  also materialize array-shaped structs, or exclude them from the data gate.)

## Method (reuse #2794's banked toolchain)

- Probe `.tmp/callargs.mjs` (in the #2794 branch) parses `foo(bar, baz)` and
  dumps `call.arguments` type/array-ness + whether the module exports
  `__is_vec`/`__vec_len`. Extend it to call `__is_vec` / `__vec_len` on the RAW
  `arguments` field (unwrap the proxy) to classify it.
- Acorn compiles in ~40s; reuse ONE compile per probe (see `.tmp/acorn-run.mjs`
  watchdog driver). The dogfood differential oracle (`tests/dogfood/ast-diff.mjs`)
  gives the equal/divergent verdict.

## Acceptance

- Compiled-acorn `parse("foo(bar, baz)")`'s `CallExpression.arguments` is a JS
  array structurally EQUAL to node-acorn (two `Identifier` nodes), via the
  dogfood differential oracle (positions + the benign `sourceFile` field
  ignored).
- A guard test (fast unit test exercising the same host vec→array AST-field
  marshaling path, + a dogfood fixture).
- Full `merge_group` + standalone-floor (broad-impact host marshaling).

## Build-on

- Depends on **#2794** (the `__is_data_struct` discriminator + vec read-methods).
  Branch fresh from `origin/main` AFTER #2794 (PR #2264) merges so this builds on
  that fix.
