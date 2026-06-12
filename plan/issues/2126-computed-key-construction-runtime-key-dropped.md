---
id: 2126
title: "object-literal construction with a runtime computed key drops the property and never evaluates the key expression"
status: done
sprint: 61
created: 2026-06-12
updated: 2026-06-12
completed: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: object-literals
goal: property-model
related: [140, 1837, 2032]
renumbered_from: "residual of #140 (done) — surfaced by #1971 re-validation"
origin: "2026-06-12 #1971 PO re-validation vs main c19a2e9c1"
---

# #2126 — computed-key object construction: runtime key dropped, key side-effect skipped

## Problem

Building an object literal whose `[key]` is not a statically-resolvable string
literal drops the property entirely, and the key expression's side effects are
never evaluated.

```ts
// runtime key not statically known → property dropped
const ks = ["p", "q"];
let k = ks[1];
const o: any = { [k]: 5 };
o.q                       // wasm: NaN      node: 5

// key expression side effect never runs
let calls = 0;
const key = (): string => { calls++; return "x"; };
const o2: any = { [key()]: 1 };
calls                     // wasm: 0        node: 1
```

A statically-resolvable computed key DOES work today
(`let k = "dyn"; ({ [k]: 42 }).dyn === 42`) — the compiler constant-folds `k`
to `"dyn"` and lays out a static struct field. The bug is the fallback: when
the key cannot be folded to a compile-time string, the property and the key
expression are both silently discarded.

This is the **construction** side. The destructuring **read** side
(`const { [k]: v } = obj`) is tracked separately by #2032.

## Root cause (pointer)

Object-literal lowering lays out a static struct from compile-time-known
property names. A `ComputedPropertyName` that doesn't fold to a literal has no
static field slot, and there is no runtime `__define_prop` fallback emitted —
so both the field write and the key-expression evaluation drop out. See
object-literal construction in `src/codegen/object-ops.ts` and the
ComputedPropertyName handling path (grep `ComputedPropertyName`).

## Acceptance criteria

- `const ks=["p","q"]; let k=ks[1]; const o:any={[k]:5}; o.q` → `5`
- `let calls=0; const key=()=>{calls++;return "x"}; ({[key()]:1}); calls` → `1`
- Statically-resolvable computed keys keep working (no regression on
  `{[literalVar]: v}`)
- An equivalence test under `tests/` covering both shapes

## Notes

Verified on main `c19a2e9c1` via `.tmp/triage.mts` / `.tmp/triage2.mts`
(branch `po-1971-triage`). JS-host mode, default options.

## Resolution (2026-06-12)

Two-part fix in `src/codegen/literals.ts`:

1. **Routing** — `compileObjectLiteral` now diverts literals with a runtime
   computed key (new `_hasRuntimeComputedKey`: a PropertyAssignment or
   MethodDeclaration whose `[expr]` neither folds via
   `resolveComputedKeyExpression` nor names a well-known `Symbol.X`) to the
   host plain-object path (`compileObjectLiteralWithAccessors`), alongside
   the existing #1239 accessor / #1433 disposal routing. The struct paths
   can only lay out compile-time-known field names.
2. **Runtime key emission** — in that path's PropertyAssignment and
   MethodDeclaration branches, an unfoldable computed key compiles its key
   expression (in source order, before the value — side effects run per
   spec) and passes it to `__extern_set` as the externref key, instead of
   `continue`-dropping the property. A method whose callback compilation
   declines keeps the previous "property skipped" semantics (key side
   effects still run).

## Test Results

- All three issue repros fixed: runtime key → 5, key side effect → 1,
  static computed key still 42 (struct fast path kept).
- `tests/issue-2126.test.ts` — 7/7: runtime key, side-effect count,
  key-before-value evaluation order, mixed static+runtime keys, static-fold
  fast path, plain/typed struct literals, well-known Symbol keys.
- Related suites (`computed-props`, `issue-computed-props`,
  `computed-property-class`, `issue-786-object-keys-dynamic`,
  `empty-object-widening`): 19/20 — the 1 failure is identical on main.
  `accessor-side-effects` fails 16/16 on main too (that is the #2127/#2128
  cluster, separate tasks).

## Out of scope (pre-existing on main, verified identical)

- `{ [n + 1]: 7 }` with `let n = 2` — `resolveConstantExpression` folds the
  `let` initializer, so this takes the struct path with field "3" and reads
  back NaN. Numeric-key struct-field reads are a separate bug (and folding
  a reassignable `let` is itself questionable).
- `{ [k]() {} }` with runtime `k` — `compileArrowAsCallback` declines for
  this MethodDeclaration shape, so the method is skipped (same observable
  "m is not a function" as main).
