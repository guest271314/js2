---
id: 2780
title: "Hybrid IR step 2: ArrayLiteral widening-escape check — vec.new_fixed only when the literal does not flow into an any/heterogeneous sink"
status: done
sprint: 69
created: 2026-06-28
updated: 2026-07-03
completed: 2026-06-28
assignee: ttraenkler/sendev-arraylit-widening
priority: medium
horizon: s
feasibility: medium
reasoning_effort: max
task_type: feature
area: codegen, ir
language_feature: array-literal
goal: correctness
related: [2755, 2762, 2766, 1530, 1804]
depends_on: [2766]
---

# #2780 — Hybrid IR step 2: ArrayLiteral widening-escape check

Second IR-adoption step of the hybrid roadmap
([`docs/architecture/hybrid-soundness-ir-roadmap.md`](../../docs/architecture/hybrid-soundness-ir-roadmap.md)
§(b); audit Row 6 in
[`plan/log/hybrid-fastpath-audit.md`](../../plan/log/hybrid-fastpath-audit.md)).
It is the clean **second exemplar** after #2766 that a safety proof can be
**local** — a fresh allocation needs no whole-function dataflow.

## Problem

`#1804` lowers a fixed-length, non-spread, same-typed array literal to a packed
`vec.new_fixed` IR node (`src/ir/from-ast.ts` `lowerArrayLiteral`). The fast path
builds a **homogeneous NARROW vec** (`vec<f64>` for `number[]`, `vec<i32>` for
`boolean[]`, …). Per the Hybrid Invariant (HI) that specialization is only sound
when the literal **provably cannot be widened** to a heterogeneous / `any`
element type.

The "all elements same static type" half of Row 6's predicate is already
enforced (the `irTypeEquals` element-type loop). The **gap** is the _"not later
widened"_ half — there was **no explicit proof** that the homogeneous narrow vec
won't flow into a wider/heterogeneous sink. Soundness today rests on two
_incidental_ mechanisms rather than an explicit HI proof:

1. the **selector** rejects functions whose locals carry a non-primitive type
   annotation (`const a: any[] = …` ⇒ `body-shape-rejected`, because
   `lowerVarDecl` only forwards **primitive** type nodes as the hint — `any[]`,
   an `ArrayType`, is dropped), so the literal never reaches the IR; and
2. for a literal **passed where an `any[]` is expected** (`g([1,2,3])`,
   `g(x: any[])`), the IR claims the function and the literal _does_ reach
   `lowerArrayLiteral` — where the externref-`hint` ≠ f64-element `irTypeEquals`
   check raises a generic _"mixed-type"_ demotion.

Both are fragile to the natural next expansion of #1804's claim scope: the moment
the selector claims an annotated-`any[]`-local function, `lowerArrayLiteral` would
infer the element type **from the elements** (`1,2,3` → f64) and build `vec<f64>`
for an `any[]`-typed slot — a latent miscompile, since the packed `vec<f64>`
cannot hold a later `a[0] = "x"` / `a.push({})`.

This slice makes the proof **explicit and the primary gate**: prove
no-widening-escape, else demote to the SAFE legacy lowering (which boxes each
element). The explicit gate (a) replaces the incidental _"mixed-type"_ demotion
for the reaching `any[]`-arg case with a clear HI reason, and (b) pre-empts the
latent narrow-build miscompile if the selector's claim scope widens. The existing
`irTypeEquals` / hint net remains as a **backstop** for any sink
`getContextualType` cannot recover at the literal's site, so no miscompile is
possible regardless of `getContextualType`'s positional reliability.

## Fix (HI prove-then-specialize, mirrors #2766)

Add a **local widening-escape proof** to `lowerArrayLiteral`. The fast
`vec.new_fixed` fires **only** when the proof holds; otherwise demote to the SAFE
correct path (legacy, which boxes each element to the dynamic externref
representation).

Proof predicate `arrayLiteralWideningEscapes(expr, cx)` — inspects only the
literal's **own TS contextual type** (`checker.getContextualType(expr)`), no
whole-function dataflow:

- bare `any` / `unknown` sink (`const a: any = [...]`) → escape → SAFE;
- array/tuple sink whose **element type** is `any` / `unknown` (`any[]`,
  `unknown[]`) → escape → SAFE;
- array/tuple sink whose element type is a **heterogeneous union**
  (`(number | string)[]`) → escape → SAFE;
- otherwise (concrete, homogeneous element type matching the narrow build, or no
  contextual type at all) → P holds → FAST `vec.new_fixed`.

### Why the comparison is on the TS _type_, never the Wasm kind (the Row-6 trap)

`number[]`, `boolean[]` and `symbol[]` **all** lower to the same Wasm element
ValType (`number[]` → f64; `boolean[]` and `symbol[]` → i32 — and packed-i32
`number[]` would also be i32). Keying the proof on the ValType kind would
misclassify a boolean-vs-number sink and either over-demote every `boolean[]`
literal or miss a real confusion. The predicate therefore reads TS `TypeFlags`.

One TS gotcha verified before coding (probe in `.tmp/`): the intrinsic `boolean`
type is internally the union `true | false`, so `type.isUnion()` returns **true**
for it. The predicate excludes it via the `ts.TypeFlags.Boolean` flag so
`boolean[]` stays on the fast path. A genuine heterogeneous union
(`string | number`) does **not** carry that flag.

### Why SAFE = demote-to-legacy for this slice (not a SAFE IR lowering)

The IR has **no number→externref box primitive** (see the `from-ast.ts`
generator/coercion comments and #2766's `emitSafeVecGet` f64 note: a `number[]`
value that must be observed as `any`/externref "already demotes the whole
function to legacy"). Building a boxed `vec<externref>` _in the IR_ is therefore
not available at this step; the SAFE correct path is the legacy lowering, which
boxes each element via `__box_number` and produces the dynamic-correct array.
This matches the roadmap's pragmatic stance ("when the IR cannot prove a
specialization … it falls to the SAFE JS-correct lowering") — legacy is the SAFE
lowering here, exactly as the #1804 spread/sparse/mixed arms already demote.

## Blast radius

Verified empirically on current main (`.tmp` probes):

- **Reaching widening case = literal passed where `any[]` is expected**
  (`g([1,2,3])`, `g(x: any[])`): reaches `lowerArrayLiteral` and now demotes with
  the **explicit HI reason** instead of the incidental _"mixed-type"_ throw — same
  outcome (legacy boxes; value identical), clearer cause.
- **Annotated `any[]`/`unknown[]`/union local** (`const a: any[] = [...]`):
  `body-shape-rejected` by the selector today, so it never reaches the IR — the
  gate is dormant defense-in-depth for it (becomes load-bearing if that claim
  scope widens).
- **`unknown[]` / `(A|B)[]` call-args**: lower via a path that does **not** reach
  `lowerArrayLiteral` and already produce JS-correct values; the gate does not
  change them.
- **FAST cases unaffected**: no-annotation `[1,2,3]`, `boolean[]` (the
  `boolean = true|false` union-flag gotcha is excluded via the `Boolean` flag),
  same-typed `number[]` call-args — all keep the fast `vec.new_fixed` path.

Demoting to legacy is **correctness-neutral or a fix** (legacy is the semantic
reference); it is never a miscompile. The only cost is a perf/byte deopt for the
reaching `any[]`-arg case, which is the HI SAFE default.

## Acceptance criteria

- `const a: number[] = [1,2,3]` (and no-annotation `[1,2,3]`, `boolean[]`,
  same-typed `number[]` params/returns) keep the FAST `array.new_fixed` IR path.
- `const a: any[]/unknown[]/(number|string)[] = [1,2,3]` demote to legacy and
  still return JS-correct values.
- No test262 regression in the `merge_group` re-validation (IR change → validated
  full-CI, not scoped).
- `pnpm run check:ir-fallbacks` stays green (refresh the post-claim baseline if a
  playground example legitimately newly demotes).

## Scope / non-goals

- Structural-supertype scalar sinks (`{}[]`, `object[]` of a scalar literal) are
  **not** flagged by this local proof — they remain covered by the existing
  downstream `irTypeEquals` net (same residual as today). Row 6 explicitly scopes
  to `any` / `unknown` / heterogeneous sinks.
- Whole-function / cross-function widening (a narrow literal assigned to a wide
  variable several statements later, or passed through covariant array
  positions) is out of the _local_ proof and stays caught by the downstream net.

## Test Results

See `tests/issue-2780.test.ts` — fast-path-when-safe (FAST, `array.new_fixed`
present, no demotion) + safe-fallback-when-not (demotes via `irPostClaimErrors`,
value still correct).
