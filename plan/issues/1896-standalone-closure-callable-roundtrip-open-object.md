---
id: 1896
title: Standalone closure callable round-trip through open-$Object (#1888 S2 prerequisite)
status: ready
goal: standalone-mode
related: [1888, 1472]
parent: 1888
feasibility: hard
reasoning_effort: high
area: codegen, runtime
language_feature: closures, objects, method dispatch
sprint: Backlog
---

# #1896 — Standalone closure callable round-trip through open-`$Object`

> **Architect spec.** This is the *representation prerequisite* that blocks
> #1888 Slice 2 (the ~7,465-record `__extern_method_call` lever — the largest
> single chunk of #1472 Phase C). sd-1472c built S1 (`__apply_closure` arity
> bridge) + the open-`$Object` arm of `__extern_method_call`, the module
> *validates*, but the feature does **not** work end-to-end because a function
> value stored into a standalone open-`$Object` loses its callable identity on
> the read-back. This spec pins down the wrapper representation both the store
> side and the dispatch side must agree on so S1/S2 can land **correctly** (not
> as a silent-wrong-answer regression of the current Phase-A `Codegen error:`
> refuse). See `plan/issues/1888-openany-dispatch.md` §"sd-1472c implementation
> findings (2026-06-05) — S1 is PREREQUISITE-BLOCKED" — this is option (A) it
> calls for.

## Problem

In `--target standalone` (pure WasmGC, zero host imports), a function value
written into an open-`$Object` (Phase-B `$Object`/`$PropMap`/`$PropEntry`
runtime) and read back does **not** survive as a callable. The Phase-B runtime
stores property values as `anyref` in `$PropEntry.$value`; a closure must round-
trip through that `anyref` slot **as its callable `$Closure`-family wrapper
struct** so that (a) `typeof o.m === "function"`, and (b) the standalone method-
dispatch path (`__apply_closure` → `__call_fn_method_N`'s
`ref.test $Closure*` → `struct.get $func` → `call_ref`) recognizes and invokes
it.

### Exact evidenced repro (verified on clean `main` AND the S1 branch by sd-1472c)

```ts
export function run(): number {
  const o: any = {};
  o["m"] = function () { return 42; };   // store a closure under a computed key
  // typeof o.m  →  must be "function"  (currently NOT — probe returns non-"function")
  return o.m();                          // must return 42  (currently returns 0, the undefined sentinel)
}
```

Today, compiled with `{ target: "standalone" }`:
- `typeof o.m` does **not** classify as `"function"` (the value read back by
  `__extern_get` does not `ref.test` as a closure base-wrapper struct, so
  `__typeof_function` — hard-coded to `0` in `addUnionImportsAsNativeFuncs` —
  and `__typeof_object` (which returns `1` for *any* non-null non-boxed-primitive)
  both misreport).
- `o.m()` returns the undefined sentinel (`0`): `__apply_closure`'s
  `__call_fn_method_N` dispatch never matches because the read-back value is not
  recognized as the funcref-bearing wrapper.

This is **not** a regression — both defects reproduce on clean `main`. On `main`,
`o.m()` in standalone is a clean Phase-A `Codegen error:` refuse; S1/S2 remove
that refuse and route native, which (without this prerequisite) converts a loud,
honest compile error into a **silent wrong answer**. That violates the
conservative dual-mode invariant. This issue makes the round-trip correct so
S1/S2 can land without that regression.

## The representation decision (the core of this spec)

**Decision: a function value stored into `$PropEntry.$value` is boxed as the
*unmodified* `$Closure`-family wrapper struct ref, via `extern.convert_any` only
(a no-op at the engine level). No `$AnyValue`-tagged re-box, no new closure-in-
object container type. The read-back path returns that *same* wrapper struct, and
both `typeof` and `__apply_closure` `ref.test`/`ref.cast` against the **same
base-wrapper type set** that `emitClosureCallExport*` / `emitClosureMethodCallExportN`
already use (`ctx.closureInfoByTypeIdx` → representative `superTypeIdx === -1`
base wrapper). The store/read/dispatch/typeof sides are reconciled by all four
keying off that single base-wrapper set.**

In two sentences: *The callable representation is the existing `$Closure` wrapper
struct (field 0 = `$func` funcref); it travels through the open-object `anyref`
slot untouched because `extern.convert_any`/`any.convert_extern` are identity at
the engine level. Correctness reduces to guaranteeing (1) the store side never
re-boxes the wrapper into a non-`ref.test`-able shape, (2) the closure's base-
wrapper type is registered in `ctx.closureInfoByTypeIdx` so a matching dispatch
arm exists, and (3) the standalone `typeof` helpers `ref.test` that same set.*

### Why a no-op round-trip is the right cut (vs a new container type)

- `$Closure` wrapper structs are `(eq)` refs. `extern.convert_any` (store) and
  `any.convert_extern` (read) are engine-level no-ops — the *identity* of the
  struct is preserved across the `externref`↔`anyref` boundary. So the wrapper
  *already* survives the data round-trip in `__extern_set`/`__extern_get` (both
  do exactly `any.convert_extern(value)` on store and `extern.convert_any(e.value)`
  on read — see `object-runtime.ts` `__extern_set` L845-852 and `__extern_get`
  L484-491). **No runtime change to `__extern_set`/`__extern_get` is required for
  the data path.** The break is on the two *recognition* sides (dispatch +
  typeof) and the *store-side coercion* that must not strip the wrapper.
- A new tagged container (e.g. `$AnyValue { tag=FUNCTION, ref=wrapper }`) would
  force `__extern_get`, `__apply_closure`, AND `typeof` to unwrap a second layer
  and would diverge the standalone representation from the gc/host path. Rejected
  — it is strictly more surface for the same result.

### The three recognition contracts that must hold

**(1) Store side — the wrapper must reach `$PropEntry.$value` un-stripped.**
`o["m"] = fn` routes through `compileExternSetFallback`
(`src/codegen/expressions/assignment.ts` L3038), which compiles the RHS value
with `expectedType: { kind: "externref" }` (L3079). For a function-expression
RHS, `compileArrowFunction` produces the closure **wrapper struct ref** and the
subsequent ref→externref `coerceType` emits a plain `extern.convert_any`
(`type-coercion.ts` L1499/L1542) — which preserves the wrapper. **Verify this
holds** for the computed-key path; if any path instead lowers a function-value
RHS to a `$AnyValue`-tagged box or a non-wrapper externref (e.g. via a typeof-
narrowed `any` slot), that path must be corrected so the externref handed to
`__extern_set` is the bare `extern.convert_any(<wrapper struct ref>)`.

**(2) Dispatch side — a `ref.test`-able arm must exist for the closure's base
wrapper.** `__call_fn_method_N` / `__apply_closure` only emit a dispatch arm for
closure types present in `ctx.closureInfoByTypeIdx`, and `ref.test` against the
representative base wrapper (`superTypeIdx === -1`) chosen at finalize
(`index.ts` `emitClosureMethodCallExportN` L3029-3071). The function expression
in the repro **must** have registered its wrapper type in `closureInfoByTypeIdx`
*before* the dispatch exports are emitted, and its base wrapper must canonicalize
to one the dispatch arm tests. (After V8 isorecursive canonicalization, all base
wrappers with one funcref field collapse — see the comment at
`emitClosureCallExport` L2334. The single-base-wrapper `ref.test` is therefore
expected to match; **confirm empirically** in Slice 0 that it does for a closure
that only ever exists as an open-object property value, since such a closure may
not otherwise be call-site-typed.)

**(3) typeof side — the standalone `typeof` helpers must recognize the wrapper.**
`compileTypeofComparison` (`typeof-delete.ts` L964-1005) calls
`__typeof_function` / `__typeof_object` for the runtime `any` case. In the
standalone/WASI native block (`addUnionImportsAsNativeFuncs`, `index.ts`):
- `__typeof_function` is hard-coded to `i32.const 0` (L7972) — **wrong** for a
  standalone closure value.
- `__typeof_object` returns `1` for any non-null non-boxed-primitive (L7937-7965)
  — it would mis-classify a closure wrapper as `"object"`.

Both must be taught the closure base-wrapper set:
- `__typeof_function(externref) -> i32`: `any.convert_extern` then chained
  `ref.test` against each closure base wrapper in `ctx.closureInfoByTypeIdx`
  (the same set `emitIsClosureExport` computes at `index.ts` L3240-3307 — reuse
  that base-type-collection logic). Return `1` on first match, else `0`.
- `__typeof_object`: after the existing null + boxed-number + boxed-bool guards,
  add a closure-base-wrapper `ref.test` guard that returns `0` (a callable is
  `"function"`, never `"object"`). Do **not** widen `__typeof_object`'s scope
  beyond the closure exclusion here (its other pre-existing approximations are
  out of scope).

## Edge cases

- **Non-callable value read back.** `o["x"] = 41; typeof o.x` must stay
  `"number"`; `o["s"] = "hi"; typeof o.s` → `"string"`; key absent → `__extern_get`
  returns null externref → `typeof o.missing` → `"undefined"`; a plain object
  value → `"object"`. The closure `ref.test` arms must be **additive** and only
  fire for genuine wrapper structs.
- **Closure with captures.** Captured-variable closures are *subtypes* of the
  base wrapper (`closures.ts` L1639-1640, L2322/L3002/L3121 register them with a
  parent struct whose field 0 is the funcref). `ref.test $baseWrapper` passes for
  subtypes, so the env/`self` field rides along untouched in the `anyref` slot.
  Confirm a capturing closure (`let k=42; o["m"]=()=>k; o.m()` → `42`) round-
  trips — the `call_ref` self-arg is `ref.cast` to the wrapper's `selfTypeIdx`
  (`emitClosureMethodCallExportN` L3040-3043), so the env is read from the same
  struct instance that was stored.
- **Arity 0–4.** Reuse the existing `__call_fn_method_0..4` dispatchers
  (sd-1472c's `__apply_closure` reads `n = i32(__extern_length(args))` and routes
  to `__call_fn_method_N`). This spec does not add new arities; it makes the
  values those dispatchers receive recognizable. Arity > 4 stays a conservative
  `Codegen error:` (existing closure-ABI ceiling), never silent-wrong.
- **`const f: any = fn; f()` (function value assigned to a *variable* `any`,
  then called) vs the object-store path.** The variable-`any` form is governed by
  **defect 2** below (a separate late-shift bug) — out of scope here. This issue
  covers only the *object property* round-trip (`o["m"]=fn` / `o.m=fn`, then
  `o.m()` / `o["m"]()`).
- **Method shorthand in a literal** (`const o: any = { m() { return 42 } }`)
  vs computed assign (`o["m"] = function(){…}`): both must end up storing the
  same wrapper representation in `$PropEntry.$value`. Slice 1 targets the
  computed-assign form; the literal-method form is verified in Slice 2.
- **Receiver threading.** `o.m()` must invoke with `this === o`.
  `__call_fn_method_N` already threads `thisVal` via the `__current_this` global
  (`ensureCurrentThisGlobal`, save/restore at L3018/3075). sd-1472c's
  `__apply_closure(__extern_get(recv,name), recv, args)` passes `recv` as
  `thisVal`. No change needed here; just covered by the integration test.

## Slicing

### Slice 0 — diagnostic confirmation (no code change beyond a probe)
Compile the repro under `{ target: "standalone" }` and dump the wasm to confirm
the mechanism: (a) the value passed to `__extern_set` is
`extern.convert_any(<wrapper struct ref>)` (store side OK), and (b) which of the
three recognition contracts fail. This pins whether the fix is *only* the two
typeof helpers + ensuring `closureInfoByTypeIdx` registration, or whether a
store-side coercion also strips the wrapper. Use a `.tmp/` probe (gitignored).
**Expected finding** (per sd-1472c): store side is fine; the breaks are typeof
(contract 3) and possibly dispatch-arm presence (contract 2). Slice 1 is scoped
by what Slice 0 confirms.

### Slice 1 (FIRST, minimal end-to-end) — `o["m"]=fn; o.m()` works standalone
Make the exact repro return `42` and `typeof o.m === "function"`, instantiating
+ running under Node WasmGC with an **empty import object** (zero host imports):
1. Fix `__typeof_function` and `__typeof_object` in `addUnionImportsAsNativeFuncs`
   to `ref.test` the closure base-wrapper set (contract 3).
2. Ensure the function-expression-as-property-value path registers its wrapper
   in `ctx.closureInfoByTypeIdx` so `__call_fn_method_N`/`__apply_closure` emit a
   matching arm (contract 2) — if Slice 0 shows no arm, force registration in the
   computed-assign RHS path (mirror how call-site-typed closures register).
3. Land S1's `__apply_closure` + the `__extern_method_call` open-`$Object` arm
   (from sd-1472c's branch `issue-1888-s1-apply-closure`) **on top of** 1+2, so
   the dispatch routes native and the values it sees are now recognizable.
4. Conservative invariant: any uncertainty (arity > 4, non-wrapper value where a
   callable was syntactically required, unresolvable closure type) ⇒ keep the
   `Codegen error:` refuse — never a silent `0`.

**What it unblocks in #1888 S2:** this is the literal prerequisite for case (b)
(open user objects), which dominates the 7,465 `__extern_method_call` rows.
Once the round-trip is correct, sd-1472c's already-built (validated) S1/S2 arms
become *correct* and can land, banking the bulk of the #1472 Phase C lever.

### Slice 2 (follow-on, in #1888 S2 proper)
Method-shorthand literals (`{ m(){…} }`), captured-variable closures stored as
properties, arity 1–4 with args, and `o["m"]()` (computed-key call). Verified by
extending the integration test; these reuse the Slice-1 representation contract.

## Exact files + functions + insertion points

**`src/codegen/index.ts`** — `addUnionImportsAsNativeFuncs(ctx)` (defined L7658).
- `__typeof_function` registration (currently L7972, `i32.const 0`): replace the
  body with `local.get 0` → `any.convert_extern` → chained `ref.test` over the
  closure base-wrapper set, return `1` on first match else `0`. Reuse the base-
  type collection from `emitIsClosureExport` (L3240-3307: walk
  `ctx.closureInfoByTypeIdx`, climb `superTypeIdx` to each root, dedup). If
  `closureInfoByTypeIdx` is empty (no closures in the module), keep the `0`
  fast path.
- `__typeof_object` registration (L7937-7968): after the existing boxed-number
  (L7950-7956) and boxed-bool (L7958-7963) `ref.test` guards and before the
  final `i32.const 1` (L7965), insert a closure-base-wrapper `ref.test` guard
  that returns `0` (callable ⇒ not object).
- **Ordering caveat (#329/#1839 class):** these helpers are registered as
  *defined* native funcs (no import shift), but they reference closure base-
  wrapper type indices, so they must be emitted **after** all closure wrapper
  types are registered (finalize order, same point as `emitIsClosureExport`
  L3240 / the `emitClosureMethodCallExportN` calls L3409-3411). If
  `addUnionImportsAsNativeFuncs` currently runs *before* closure finalize,
  factor the two typeof bodies into a post-closure-finalize fill step (mirror the
  reserve-then-fill pattern sd-1472c used for `__apply_closure`,
  `reserveApplyClosure`/`fillApplyClosure` in object-runtime.ts on the S1 branch).

**`src/codegen/expressions/assignment.ts`** — `compileExternSetFallback` (L3038).
- Verify (Slice 0) the RHS at L3079 (`compileExpression(value, {externref})`)
  yields `extern.convert_any(<wrapper>)` for a function-expression value. If a
  function-value RHS instead registers no `closureInfoByTypeIdx` entry (because
  it is never call-site-typed), add the registration here (mirror the call-site
  closure-typing path in `expressions/calls-closures.ts` L587-795). Do **not**
  change the externref coercion itself unless Slice 0 shows it strips the wrapper.

**`src/codegen/object-runtime.ts`** — `__extern_set` (L781-866) / `__extern_get`
(L434-517): **no change** to the data path (the `any.convert_extern` store /
`extern.convert_any` read already preserve wrapper identity). Listed here only to
document that they are intentionally untouched.

**`src/codegen/object-runtime.ts`** (S1, from the `issue-1888-s1-apply-closure`
branch, lands on top): `reserveApplyClosure`/`fillApplyClosure` (`__apply_closure`)
and the `__extern_method_call` open-`$Object` arm. Not re-specified here — they
exist and validate; this issue is their prerequisite.

## Test approach

Extend **`tests/issue-1472.test.ts`** (the standalone object-runtime suite —
established pattern: `compile(src, { target: "standalone" })`,
`assertNoHostObjectImports(r.imports)`, `WebAssembly.validate`,
`WebAssembly.instantiate(r.binary, {})` with an **empty** import object, then call
the export). Add:

1. **Slice-1 core** — computed-key closure store + call:
   ```ts
   export function run(): number {
     const o: any = {};
     o["m"] = function () { return 42; };
     return o.m();
   }
   ```
   Assert `run() === 42`, zero `env::__extern_*` / `__apply_closure` / closure
   host imports, validates, instantiates with `{}`.
2. **typeof recognition** — `typeof o.m === "function"` returns a truthy i32;
   `typeof o.x` (a number prop) stays `"number"`; `typeof o.missing` →
   `"undefined"`.
3. **Capturing closure** — `let k = 7; o["m"] = () => k * 6; o.m()` → `42`.
4. **Negative / fail-loud** — a non-callable read invoked (`o.x = 1;
   (o.x as any)()` shape, if expressible) must NOT silently return `0`; assert
   the compile refuses with `Codegen error:` rather than emitting a silent-wrong
   call. (Keep this guard test in sync with the conservative invariant.)
5. **Slice-2 (added when #1888 S2 lands)** — method-shorthand literal
   `{ m(){return 42} }`, arity-1..4 with args, `o["m"]()` computed-key call.

## Relationship to defect 2 (`const f: any = fn; f()` late-shift)

Defect 2 — `const f: any = function(){return 42}; f()` producing invalid wasm
`__str_flatten: call[0] expected (ref null 5) found i32` — is the **#329 / #1839
late-registration func-index-shift class** (a closure value in an `any`
*variable* slot alongside string ops triggers a late string-helper import that
shifts indices). It is **separately owned by #329 / PR #1209** (funcref guard +
re-resolve-by-name fix). **Do NOT re-spec or fix it here.** Note only that
#1888 **S2 also depends on #329 landing**, because programs that hold a closure
in an `any` variable *and* hit the open-object dispatch will trip defect 2
independently of this round-trip fix. The two are orthogonal prerequisites for
S2; both must land.

## Conservative invariant (gating)

Standalone-only, `ctx.standalone`-gated; **never alter the JS-host/gc path**
(those typeof helpers stay host imports — see `addImport` L7426/L7430). Any
uncertainty (closure type not resolvable, arity over the ABI ceiling, a value
where a callable was syntactically required but no wrapper is present) ⇒
fail-loud `Codegen error:`, never a silent wrong answer and never a leaked host
import. This preserves the dual-mode contract: standalone either runs correctly
or refuses at compile time.
