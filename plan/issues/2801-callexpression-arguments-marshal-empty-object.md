---
id: 2801
title: "[SENIOR-DEV ONLY] compiled-acorn CallExpression `arguments` marshals as `{}` not an array (host vec→array gap)"
status: done
completed: 2026-06-29
assignee: ttraenkler/unassigned
sprint: 69
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
created: 2026-06-28
updated: 2026-07-03
task_type: bugfix
area: codegen
language_feature: value-representation
goal: acorn-dogfood
related: [2794, 2784, 2664, 2674, 2806]
depends_on: [2794, 2806]
blocks: []
---

# #2801 — compiled-acorn CallExpression `arguments` marshals as `{}` not an array

> **Resolution (2026-06-29).** Resolved by the untyped-array-representation fix
> #2806 + #2809 (route acorn's `void 0`-pinned evolving `undefined[]` to an
> externref vec so pushed AST-node refs survive instead of coercing to `0`).
> Verified on freshly-compiled pinned acorn@8.16.0 (`skipSemanticDiagnostics:
> true`): `parse("foo(bar,baz)").arguments` → `["Identifier","Identifier"]` (a
> real JS array of nodes, no longer `{}`/`[0,0]`). The substrate enablement from
> the #2264/#2272/#2275/#2301 chain (call-expression parsing) is also in place.

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

## Implementation Notes (sendev-acorn-callargs, 2026-06-28)

Instrument-first investigation (probes in `.tmp/callargs*.mjs`,
`.tmp/elemdbg.mjs`) found the bug is **two distinct layers**, not one:

### Layer 1 — host vec→array marshaling (FIXED, branch `issue-2801-callexpr-arguments-marshal`)

The candidate "vec not recognized on read-back" was correct. The flow:

- `Program.body` reaches the host as a **host-backed JS array** (`isArray=true,
  isWasm=false`) whose elements are `_wrapForHost` proxies of the AST nodes — so
  `ast.body` walked fine and looked like the bug was call-specific.
- But it is **not** call-specific: `ArrayExpression.elements` is `{}` too. Any
  array read **through** the `_wrapForHost` proxy chain (i.e. a nested array
  field, not the top-level body) hit the get-handler vec branch
  (`__is_vec(val)===1 → _wrapForHost(val)`), which returns the **generic object
  proxy** of the vec. That proxy has no `length`/index surface → marshals as
  `{}` (`Array.isArray` false, `length` undefined). `_structToPlainObject` is
  only ever called for the top-level `Program` (confirmed by instrumentation);
  the nested CallExpression/ArrayExpression nodes are lazy proxies, so the
  marshaling decision is made entirely in `_wrapForHost`.
- **Fix**: `_wrapVecForHost` in `src/runtime.ts` — a Proxy with a real `[]`
  target (`Array.isArray` true) whose traps serve `length` + numeric indices
  LIVE from the vec (`__vec_len`/`__vec_get`), reverse-mapped to the raw vec so
  `__extern_method_call` (`scopeStack.push` → `__vec_push`) still works. Routed
  at the top of `_wrapForHost` on the positive `__is_vec` discriminator. After
  this, `arguments`/`elements` present as real JS arrays with correct length.

### Layer 2 — vec element representation (NOT fixed — escalated; the real blocker)

With Layer 1 in place, `arguments` is `[0, 0]`, not the two Identifier nodes.
Decisive probe (`DBG2801` in `_wrapVecForHost.elemAt`):
`__vec_get(argsVec, 0)` returns `number 0` (`rawTypeof=number, rawIsWasm=false`,
`__vec_mut_supported=1`, `__vec_len=2`). So the `arguments` vec is a **real,
growable vec whose backing-array element kind is numeric (f64)** — when acorn
pushes AST node references they are coerced to f64 `0`. `__vec_get` faithfully
returns `0`; `call.optional` likewise reads `0` not `false`.

Origin: `compileArrayLiteral` empty-array path (`src/codegen/literals.ts`
~3087-3162) resolves `emptyElemKind` from the contextual/`getTypeAtLocation`
type of the `[]` literal. acorn is plain JS (no annotations); the
`arguments`/`elements` array literals resolve to a **numeric** element kind
(while `body` happens to resolve to a host externref array — hence the split).
This is a vec **element-representation / type-inference** issue at the
array-literal lowering site, a different substrate class from host marshaling,
with broad blast radius (touches every untyped/evolving array). It needs an
architect decision + full `merge_group` validation. **#2801 acceptance is
blocked on Layer 2.** Layer 1 is committed as standalone, correct progress.
