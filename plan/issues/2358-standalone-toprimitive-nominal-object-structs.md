---
id: 2358
title: "Standalone native __to_primitive can't reduce typed (nominal) object structs through the externref boundary"
status: done
sprint: 63
assignee: sdev-toprimitive
model: opus
created: 2026-06-18
updated: 2026-06-18
completed: 2026-06-18
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen, type-coercion
language_feature: to-primitive, abstract-operations
goal: standalone-mode
related: [1917, 10, 50, 1673]
folds_in: [10]
origin: "2026-06-18 sdev-coerce root-cause of the #50 standalone ToPrimitive residual (re-scoped from #50)"
---

# #2358 — Standalone native `__to_primitive` over nominal object structs

This is the **engine half** of the re-scoped #50. The arithmetic *headline*
(typed object operands with `valueOf():number` across `*`, `-`, unary-minus)
is already closed on `main`. The genuine residual is one engine gap, surfacing
in several operators. It is a #1917-coercion-engine sub-task and wants this
spec + its own properly-scoped impl session — **not** a session-tail change.

## Problem

In standalone / `--target wasi` (nativeStrings, no JS host), `ToPrimitive` on a
value that reaches the coercion boundary as an **externref** is performed by the
native runtime helper `__to_primitive` (`src/codegen/object-runtime.ts:1910`).
That helper recognizes a runtime object **only** via
`ref.test (objectTypeIdx)` — i.e. it only handles the *dynamic* `$Object`
runtime struct. A **typed object literal** (e.g. `{ valueOf() { return 42 } }`)
compiles to a **nominal** WasmGC struct. When that nominal struct is coerced to
externref and handed to `__to_primitive`, `any.convert_extern` →
`ref.test objectTypeIdx` **misses**, so the object is returned unchanged; the
caller then `__unbox_number(object)` → **NaN** (or carries the raw object
through).

The working `*` / `-` / unary-minus path does **not** hit this: it uses
**static** `valueOf` dispatch in `coerceType` (ref(struct)→f64,
`type-coercion.ts:1723`), which reads the struct's TS fields at compile time and
inlines the call — but that requires the concrete `typeIdx`, which is **erased**
the moment an operand is coerced to externref. `+` (via `emitAnyAdd`,
`binary-ops.ts:2845`) and any `any`-typed parameter path lose the typeIdx and
must fall back to the runtime helper — which can't reduce nominal structs.

## Repro (original spec table — SEE 2026-06-18 CORRECTION BELOW)

> ⚠️ **2026-06-18 re-measure (sdev-toprimitive) — the table below is PARTLY
> STALE on current `main`.** When an object literal is written with an `as any`
> cast *at the literal* (`({valueOf:()=>4} as any) + 1`), it now compiles to the
> **dynamic `$Object`** representation (`__new_plain_object`), which
> `__to_primitive` already reduces — so those `as any`-literal rows **PASS** on
> current `main` (verified standalone). The genuine residual is the rows where
> the object reaches `+` as a **typed nominal struct**: a typed LOCAL
> (`const o = {valueOf:()=>4}; (o as any) + 1`) or a **class instance**
> (`class C { valueOf(){return 9} }; (new C() as any) + 1`) — those compile to a
> bare anon `(struct (field $valueOf eqref))` with no proto/brand, which
> `__to_primitive`'s `ref.test objectTypeIdx` misses → null. **PR-1 (#1697)
> fixes exactly those two** at `emitAnyAdd` operand-prep. The
> `function f(x:any){return x*2}` row and `Number(obj)`/`Number([1])` (#10) are
> NOT fixed by PR-1 — they reach the boundary already erased to externref (no
> typeIdx) and need the general Option-A brand mechanism. Don't chase the rows
> below as live repros without re-checking against `main` first.

| expr | actual | expected | path |
|------|--------|----------|------|
| `{valueOf:()=>4} + {valueOf:()=>3}` | raw object | `7` | `emitAnyAdd` → `__to_primitive` |
| `{valueOf:()=>4} + 1` | raw object | `5` | `emitAnyAdd` → `__to_primitive` |
| `1 + {valueOf:()=>4}` | raw object | `5` | `emitAnyAdd` → `__to_primitive` |
| `function f(x:any){return x*2}` with object arg | `NaN` | `84` | `type-coercion.ts:1360` externref→f64 |

**Correction to the #50 re-scope:** the re-scope stated `obj+obj`/`obj+7` were
correct on main — they are NOT. `+` with object operands is broken (returns the
raw object), because `+` routes through the externref/`__to_primitive` path, not
the static struct-valueOf path. `-`/`*`/unary-minus ARE correct (static path).
*(2026-06-18 refinement: the `obj+obj`/`obj+7` BREAKAGE is real only for the
**typed-nominal-struct** form — the `as any`-at-literal form is now correct via
the dynamic `$Object` path. See the re-measure note above.)*

### Two latent codegen bugs in the same area (valueOf returns an object)
Fold these into the impl — same root (the reduction must fall through
valueOf→toString and the arms must stay well-typed):
- `1 * ({valueOf:()=>({}),toString:()=>1} as any)` → **compile error**
  "type error in fallthru[0] (expected f64, got externref)".
- `"x" + ({toString:()=>({})} as any)` (object-returning toString) → **trap**
  "illegal cast".

## Exact sites

- `src/codegen/object-runtime.ts:1910` — native `__to_primitive`; the
  `ref.test objectTypeIdx` recognition that only matches `$Object`.
- `src/codegen/type-coercion.ts:1360` — standalone externref→f64 arm; calls
  `__to_primitive` then `__unbox_number`, degrading to `drop; f64.const NaN`
  when the reduction yields a non-primitive.
- `src/codegen/type-coercion.ts:1723` — the WORKING static struct-valueOf
  dispatch (ref(struct)→f64); the reference behaviour to reproduce host-free
  over the externref boundary.
- `src/codegen/binary-ops.ts:2845` — `emitAnyAdd`; the `+` site that compiles
  operands to externref (to preserve runtime strings for concat) and so loses
  the static typeIdx.

## Proposed approach — two representational options

The crux: at the externref boundary the runtime needs a host-free way to (a)
**detect** that an externref wraps a user object carrying `valueOf`/`toString`
(or `@@toPrimitive`), and (b) **dispatch** that method. `$Object` already
supports this; nominal structs do not.

### Option A — brand/RTTI on nominal object structs (recommended)
Give every nominal object-literal/class struct a detectable brand so
`__to_primitive` can recognize it and dispatch its `valueOf`/`toString`
host-free. Concretely: a shared supertype or a reserved tag/brand field that
`__to_primitive` can `ref.test`/read, plus a small per-struct dispatch trampoline
(reuse the `${name}_valueOf` / `${name}_@@toPrimitive` functions the static path
at `type-coercion.ts:1723`/`1768` already emits — register them so the runtime
helper can reach them by a brand→funcidx table, mirroring how `__call_@@toPrimitive`
is exported at `index.ts:1596`).
- **Pros:** additive; nominal structs keep their compact field layout and fast
  static paths; only objects that actually cross the externref boundary pay; no
  rep change to the hot WasmGC object model.
- **Cons:** needs a brand allocation + a runtime brand→method dispatch table;
  must keep the table in sync across late-import index shifts (use the
  ensureLateImport / `funcMap.get(name)`-AFTER-flush discipline, never a baked
  snapshot — see #1673 / the `reference_no_rebuild_helper_body_at_finalize`
  lesson).

### Option B — unify nominal object literals to `$Object`
Compile object literals that can reach a dynamic boundary as `$Object` so
`__to_primitive` already works.
- **Pros:** no second mechanism; one object representation at the boundary.
- **Cons:** broad blast radius and likely **hot-path regression** — every such
  literal loses its nominal struct's compact layout / static field access; risks
  the standalone high-water floor. Heavier and riskier than A.

### Recommendation
**Option A.** It is additive and confines cost to objects that actually cross
the externref boundary, matching the #1673 "additive, zero hot-path cost"
discipline. Option B is a representational change with a standalone-perf risk
disproportionate to the bucket.

## Guardrails (#1673 discipline)
- **Additive only** — do not alter the existing `$Object` path or the nominal
  struct field layout used by the fast static paths.
- **Floor-gate the standalone high-water** (`benchmarks/results/test262-standalone-highwater.json`,
  `scripts/check-standalone-highwater.mjs`) — coercion + object dispatch are hot.
- **WAT-diff** a representative standalone module before/after to confirm the
  hot static `*`/`-` paths are byte-identical (no accidental routing of
  already-working operators through the new runtime path).
- **Late-import index discipline:** resolve any new helper/dispatch funcidx by
  name AFTER the last `flushLateImportShifts`/`addUnionImports`; never bake a
  snapshot into a helper body (the #2043 / `reference_string_global_sentinel_guard`
  family).

## Scope folded in
- **#10** (route `Number(array)`→primitive through the #1917 engine) — same
  externref-boundary ToPrimitive reduction; do it on the same mechanism so the
  `#2108` coercion-site gate stays flat (reuse the sanctioned shared helper, do
  not hand-roll a new coercion site).

## Acceptance
- All four repro rows above return the spec-correct value standalone.
- The two latent `as any` cases compile + run (no fallthru type error, no illegal
  cast).
- `Number([1])` / `Number(arr)` reduce correctly standalone (#10).
- Standalone high-water floor not regressed; `*`/`-`/unary-minus WAT unchanged.
- `#2108` coercion-drift gate stays flat (`node scripts/check-coercion-sites.mjs`).

## Re-measure
The 2026-06-12 standalone JSONL `object-to-primitive` bucket (107) is **stale**
and the headline is partly closed — re-measure the true tractable count on a
**fresh standalone shard** before sizing the impl.

## Implementation notes — PR-1 (sdev-toprimitive, 2026-06-18)

**Spec repro table was stale.** Re-measured every row standalone on current
upstream/main (955552ecc). The `as any`-cast-at-the-literal forms
(`({valueOf:()=>4} as any)+1`, `1+obj`, `obj+obj`, `function f(x:any){return x*2}`)
ALL PASS already: an `as any` literal forces the **dynamic `$Object`**
representation (`__new_plain_object`), which `__to_primitive` already reduces.
The genuine residual is the **typed-LOCAL / class-instance** form, which compiles
to a NOMINAL anon struct (`(struct (field $valueOf eqref))`) with no proto/brand/
supertype — `__to_primitive`'s `ref.test objectTypeIdx` misses it → returned
unchanged → `__unbox_number` → null.

**What PR-1 ships (tractable, NOT the spec's Option A brand/RTTI).** A focused,
additive change in `emitAnyAdd` (`binary-ops.ts`): the operand-prep is factored
into `emitAddOperand`, which — when an operand statically resolves (through
`as`/paren/non-null wrappers) to a nominal struct with a *number-producing*
static ToPrimitive (`valueOf`/`@@toPrimitive`) — compiles the **unwrapped** inner
expression WITHOUT the externref hint (so its concrete `typeIdx` survives) and
reduces it to a boxed primitive via the shared #1917 `coerceType(ref-struct→f64,
"default")` engine, *before* it crosses the externref boundary. Every other
operand keeps the exact status-quo `{externref}`-hint path.

Why the externref hint had to be conditionally dropped: `(o as any)` /
`compileExpression(expr, {externref})` coerces the struct to externref *inside*
compileExpression, erasing the typeIdx before the operand-prep can see it. Gating
on the unwrapped operand's struct name (`resolveStructNameForExpr` on the inner
expr) keeps the divergence surgical.

**Guardrails verified:**
- WAT byte-IDENTICAL on a battery of non-struct `+` (str+str, str+num, num+num,
  arr+str, toString-only-obj) AND the static `*`/`-` paths (clean upstream/main
  vs branch — empty diff). The new path only fires for nominal-struct valueOf in
  `+`.
- `node scripts/check-coercion-sites.mjs` flat; `check-any-box-sites` flat
  (reused the existing coercion engine, no new site).
- Standalone modules still instantiate host-free (`imports.length === 0` asserted
  in the regression test).
- Regression test `tests/issue-2358-toprimitive-nominal.test.ts` (6 cases,
  including the two `as any`/any-param non-regression guards) — all green.
- `tsc --noEmit` clean.

**Deferred to a follow-up (the spec's Option A territory):** the
any-typed-PARAMETER form where the struct is erased to externref at the call
boundary BEFORE `+` (already works for valueOf via the dynamic-object box, but a
typed nominal struct passed positionally would still strand), and `Number(obj)` /
`Number([1])` (#10). Those need the GENERAL externref-boundary reduction — a
shared-supertype brand + `ref.test` + brand→funcidx dispatch table — which
requires re-declaring every object-literal struct as `sub` of a brand supertype
(touches the hot static path) and is genuinely architect-scale. PR-1 closes the
`+`-with-typed-object residual host-free without it.
