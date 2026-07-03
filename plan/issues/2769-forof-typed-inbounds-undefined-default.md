---
id: 2769
title: "[ARCH] for-of typed in-bounds undefined/hole default-init — representation-level carve (split from #2669)"
status: done
assignee: ttraenkler/forof769
completed: 2026-06-28
created: 2026-06-28
updated: 2026-07-03
priority: medium
feasibility: hard
reasoning_effort: high
task_type: bug
area: codegen
es_edition: 2015
language_feature: destructuring
goal: spec-completeness
related: [2669, 2216]
sprint: 69
---

# #2769 — for-of typed in-bounds `undefined`/hole default-init (architect carve)

Split out of the #2669 destructuring umbrella. This is the **typed in-bounds
sentinel-propagation** slice the umbrella flagged as "the next carve" — it needs
a **representation-level** design, not a value-side patch. A dev attempt
(PR #2226) was closed because the obvious fix is architecturally unsound (see
below). Routed to architect.

## Symptom

```js
for (const [x = 23] of [[undefined]]) { … }   // x should be 23; we produce 0/NaN
for (const [x = 23] of [[,]])        { … }     // hole — same bug
```

Real failing test262 (~8–14 tests):
`language/statements/for-of/dstr/{const,let,var}-ary-ptrn-elem-id-init-{undef,hole}.js`,
plus `array-elem-nested-{array,obj}-undefined-own.js`.

## The KEY ASYMMETRY (the crux for the design)

**Binding patterns ALREADY PASS on main; the identical for-of FAILS.**

| form | passes? | why |
|------|---------|-----|
| `let [[x = 23]] = [[undefined]]` | **PASS** (→ 23) | TS infers `[[undefined]]` as a **TUPLE** → tuple-struct → the f64 **sNaN sentinel** (`0x7ff00000deadc0de`) is emitted for undefined-like elements (`compileTupleLiteral`, `literals.ts`) → the destructuring default-check (`i64.reinterpret_f64` == sentinel) fires. |
| `for (const [x = 23] of [[undefined]])` | **FAIL** (→ 0) | TS infers the iterable as an **ARRAY** (`undefined[][]`) → `resolveWasmType` lowers the inner `undefined[]` to **`vec_i32`** → the inner `[undefined]` literal (built fresh as `vec_externref` holding the `undefined` externref) is COERCED to `vec_i32` (`__unbox_number` → `i32.trunc_sat_f64_s` → **`0`**), identity LOST → the default-check on the coerced f64 `0.0` never matches the sentinel. |

So the binding path already has a correct mechanism (tuple + f64 sentinel); the
for-of path loses `undefined` at **construction** because the element is an
ARRAY, not a TUPLE.

## Why the obvious dev fix is unsound (PR #2226, closed)

Widening `undefined[]`/`void[]` from `vec_i32` → externref in `resolveWasmType`
**fixed the for-of** (+35 dstr wins) but `resolveWasmType` is **type-deterministic**
(a given TS type must resolve to ONE backing everywhere), so it changed the
backing for ALL undefined-typed arrays and produced 5 merge-group regressions:

- **Construction** — `new Array(undefined, undefined)` / `[, , ,]` emit
  `array.new_fixed` with `i32.const 0` for undefined/hole elements → invalid Wasm
  ("expected externref, found i32"): `built-ins/Array/S15.4.2.1_A2.1_T1.js`,
  `built-ins/Array/prototype/sort/S15.4.4.11_A1.3_T1.js` (compile_error).
- **i32/f64 consumers** assume numeric backing → `built-ins/Array/S15.4.1_A2.1_T1.js`
  (length, assertion_fail), `built-ins/Array/prototype/reduceRight/15.4.4.22-8-c-4.js`
  (null_deref), `language/module-code/top-level-await/syntax/for-in-await-expr-this.js`
  (illegal_cast).

The +35 wins and −5 regressions are **inseparable** in this approach. Scoping
attempts that were ruled out:
- `_depth >= 1` gate — fails: the for-of resolves its inner `undefined[]` at depth 0
  too (same call site as `new Array`), so depth can't distinguish them, and a
  depth-dependent type breaks resolveWasmType consistency.
- f64 backing instead of externref — worse: breaks both the for-of and construction.

## Candidate approach (for the architect to evaluate)

**Type the for-of-over-array-LITERAL elements as TUPLES**, so the existing
`isTupleStruct` for-of destructure branch (`src/codegen/statements/loops.ts`,
~L1604 — the branch BEFORE the vec-array branch ~L1697) handles them with the
tuple + f64-sentinel mechanism the binding path already uses. This keeps the
fix LOCAL to the for-of and avoids changing the global array element
representation. Open questions the spec must resolve:
- Does typing the iterable's elements as tuples interact correctly with runtime
  iteration (length/break/continue/closures-per-iteration)? The for-of loops a
  runtime vec, not a compile-time literal.
- Restrict to the case where the iterable is a direct array literal whose element
  literals are array/object literals (the spec'd templates), to avoid perturbing
  general for-of-over-array.
- Alternative: a dedicated undefined-bearing array representation, or carrying the
  undefined sentinel through the externref→i32 coercion — both are broader.

## Acceptance

- The ~8–14 listed for-of/dstr `*-id-init-{undef,hole}` + `*-undefined-own` tests
  flip fail→pass.
- ZERO regression in `built-ins/Array/**` construction/consumer tests
  (validate the full `merge_group` / test262 floor, NOT a scoped sweep — the
  PR #2226 regressions were ONLY caught by the merge-group re-validation).
- No change to the global `undefined[]`/`void[]` array backing.

## Notes

- The #2216 nested-array-default codegen slice of #2669 is already **done/merged**
  and is unaffected.
- Umbrella: #2669.

---

## Implementation Plan

> Architect verdict: the issue's *candidate* (re-type the inner elements as
> **tuples**) is sound but NOT the lowest-risk option. I recommend a different —
> strictly smaller — representation carve: **preserve the inner array's
> `externref`/`undefined` identity at construction of the for-of subject**, so the
> per-element value reaches the destructure as `undefined` (or `$Hole`→`undefined`)
> and the **already-working** `wantUndefinedSentinel` vec-destructure path fires the
> default. This is one construction-site change + one scoped flag; it reuses the
> existing read path **verbatim** (zero edits to the destructure branches) and
> avoids the tuple arity gap (see "Why not tuples" below).

### Root cause (verified against current `main`, `0a67b9a`)

`mapTsTypeToWasm` maps the leaf `undefined`/`void` type to **`i32`**
(`src/checker/type-mapper.ts:61-63`), so `resolveWasmType(undefined[])` →
`__vec_i32` (`src/codegen/index.ts:11610-11622`). For
`for (const [x = 23] of [[undefined]])`:

1. The subject `[[undefined]]` is an **array** (`undefined[][]`), so the OUTER
   `compileArrayLiteral` derives its element type from the first element
   `[undefined]`: `elemWasm = resolveWasmType(getTypeAtLocation([undefined])) =
   resolveWasmType(undefined[]) = (ref __vec_i32)`
   (`src/codegen/literals.ts:3242-3244`).
2. The inner `[undefined]` **naturally** builds as `__vec_externref` (its own
   first element is `undefined`-like → `externref`; the f64-adoption at
   `literals.ts:3236` only fires for an `f64` contextual element, not `i32`).
   The OUTER element loop then compiles it with the i32-vec hint
   (`compileExpression(el, elemWasm)`, `literals.ts:3462`), which **coerces**
   `__vec_externref → __vec_i32` element-wise (`__unbox_number` →
   `i32.trunc_sat_f64_s` → **`0`**). **The `undefined` identity is destroyed
   here, at construction of the OUTER vec — not at read.**
3. for-of (`compileForOfArray`, `loops.ts:3721`) reads `elemType = (ref
   __vec_i32)`; the destructure (`compileForOfDestructuring`, the "Vec array"
   branch, `loops.ts:1696`) sees `innerElemType.kind === "i32"`, so
   `wantUndefinedSentinel` is **false** (`loops.ts:1862-1864`) and
   `emitDefaultValueCheck` lands in its **i32 arm** —
   *"no reliable undefined sentinel, just assign"*
   (`statements/destructuring.ts:663-668`) → `x = 0`.

The binding path (`let [[x=23]] = [[undefined]]`) passes because TS gives the
literal a **tuple** contextual type → `compileTupleLiteral` →
`getTupleElementTypes` promotes `undefined`→`f64` (`index.ts:11342-11344`) → the
f64 sNaN sentinel `0x7ff00000deadc0de` is stored → `emitDefaultValueCheck`'s f64
arm matches it (`destructuring.ts:636-650`). The for-of has no tuple contextual
type, so it never gets that promotion.

**Because the value is already a bit-identical `0` by the time the loop reads it,
no read-side fix is possible — the carve MUST be at subject construction. This is
why the issue is "representation-level".**

### The fix — preserve inner `externref`/`undefined` at the for-of subject

When the for-of subject is a **direct array literal** AND the loop binding is a
destructuring pattern that needs in-bounds-undefined identity, build the OUTER
vec with an **`externref`-backed inner element type** instead of `i32`-backed.
Then **no coercion happens** (the inner already builds `__vec_externref`), the
`undefined`/`$Hole` survives, and the existing read path does the rest:

- `[[undefined]]`: inner slot holds JS `undefined` → in-bounds read →
  `__extern_is_undefined` true → default fires → `x = 23`.
- `[[,]]` (hole): inner slot holds `$Hole` (`literals.ts:3450-3460`,
  `emitHoleSentinel`); `emitBoundsCheckedArrayGet`'s read-boundary map
  (`array-methods.ts:481-483`, gated on `ctx.usesArrayHoles` which the program
  pre-scan already set, `array-holes.ts:58-72`) turns `$Hole → undefined` →
  default fires → `x = 23`.
- `for ([[ x ]] of [[undefined]])` / `for ([{ x }] of [[undefined]])`
  (`*-undefined-own`, **assignment** form, must **throw** `TypeError`): the
  in-bounds `undefined` reaches the nested sub-pattern; the assignment path's
  `emitExternrefDestructureGuard` (RequireObjectCoercible,
  `loops.ts:2083-2085` / `2155`) throws — which today never happens because the
  value is `0`.

### Changes

**File: `src/codegen/statements/loops.ts`**

- **`compileForOfArray` (def `loops.ts:3684`)** — at the subject compile site
  (`loops.ts:3697-3698`: `const vecType = preVec ? … : compileExpression(ctx,
  fctx, iterableOverride ?? stmt.expression)`), set a scoped ctx flag **around
  that one `compileExpression` call** when a pre-check passes, and clear it in a
  `finally`:
  ```ts
  const subjectExpr = iterableOverride ?? stmt.expression;
  const preserveUndef =
    !preVec &&
    ts.isArrayLiteralExpression(subjectExpr) &&
    forOfDstrNeedsInboundsUndef(stmt.initializer);     // new local helper
  if (preserveUndef) (ctx as any)._forOfPreserveUndefElem = true;
  let vecType;
  try {
    vecType = preVec ? preVec.vecType : compileExpression(ctx, fctx, subjectExpr);
  } finally {
    if (preserveUndef) (ctx as any)._forOfPreserveUndefElem = false;
  }
  ```
  Use the `(ctx as any)._flag` idiom already used by `_arrayLiteralForceVec`
  (`loops.ts:1756`) rather than adding a typed field — keeps the diff to two
  files. (If you prefer a typed field, add `_forOfPreserveUndefElem?: boolean`
  near `usesArrayHoles` in `src/codegen/context/types.ts:821` — optional.)
  - Note: the tentative probe `compileForOfArrayTentative` (`loops.ts:3635`)
    compiles the subject speculatively only to confirm vec-ness, then **rolls
    back and calls `compileForOfArray` again** — so the flag does **not** need to
    be set during the probe; setting it on the real compile (above) is
    sufficient and the probe's vec-ness check (`getArrTypeIdxFromVec >= 0`) is
    true for both `__vec_i32` and `__vec_externref`.

- **New local helper `forOfDstrNeedsInboundsUndef(initializer)`** (place near the
  other for-of helpers in `loops.ts`). Returns true when the loop variable is a
  destructuring pattern (binding: `ts.isVariableDeclarationList` whose sole
  decl name is an array/object binding pattern; assignment: `stmt.initializer`
  is an array/object literal) AND the pattern contains **either** an element
  with a **default initializer** (`BindingElement.initializer` /
  `BinaryExpression`-with-`=` in the assignment form) **or** a **nested
  array/object sub-pattern**. Rationale: only those two shapes need to
  distinguish in-bounds `undefined` from a real value (`id-init` needs the
  default; `*-undefined-own` needs the RequireObjectCoercible throw). Gating
  this tightly keeps every other `for…of` over an array literal **byte-identical**
  (no externref widening), which is what bounds the merge-group blast radius.
  - Only inspect the **top-level** pattern elements (one level is enough for the
    listed templates; recursion is unnecessary and widens scope).

**File: `src/codegen/literals.ts`**

- **`compileArrayLiteral` (def `literals.ts:3061`)** — immediately AFTER the
  outer element type is derived at `literals.ts:3242-3244` (the `else` arm that
  sets `elemWasm = resolveWasmType(firstElemType)`), add a scoped re-key:
  ```ts
  // (#2769) for-of subject carve: when the for-of binding needs in-bounds
  // `undefined` identity and this literal's elements are themselves arrays
  // whose backing would be i32-because-of-undefined (`undefined[]`/`void[]`),
  // build the OUTER vec over `externref`-backed inner vecs so the inner
  // `undefined`/hole survives (no `__vec_externref → __vec_i32` unbox).
  if (
    (ctx as any)._forOfPreserveUndefElem &&
    (elemWasm.kind === "ref" || elemWasm.kind === "ref_null") &&
    innerVecElemKindIsI32DueToUndef(ctx, firstElem)   // small predicate, see below
  ) {
    const extVecIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
    elemWasm = { kind: "ref_null", typeIdx: extVecIdx };
  }
  ```
  - `innerVecElemKindIsI32DueToUndef`: returns true when `firstElem` is an
    `ArrayLiteralExpression` whose TS element type carries
    `ts.TypeFlags.Undefined | ts.TypeFlags.Void` (i.e. `undefined[]`/`void[]`),
    OR whose elements are all holes/`undefined`-like (`_isUndefinedLike`, already
    in this file at `literals.ts:92`). This is the precise set the leak hits;
    `number[]`/`string[]`/struct inner arrays are untouched.
  - **Important ordering:** this re-key must run BEFORE
    `getOrRegisterVecType(ctx, elemKind, elemWasm)` at `literals.ts:3434-3435`
    (it just changes which `elemWasm`/`elemKind` feed that registration). It must
    run AFTER the `firstElem` derivation but the `#2106 any[]` widen
    (`literals.ts:3422-3433`) is unrelated (fires only for i32/f64 `elemWasm`, not
    `ref`), so placement right after `3244` is clean.
  - **Do NOT clear the flag here** — the inner `[undefined]` literal compiles
    under the still-set flag, but its own elements are `undefined` (not array
    literals), so `innerVecElemKindIsI32DueToUndef` is false for it and it is a
    no-op. The flag is naturally self-limiting to the level(s) whose elements are
    undefined-bearing arrays, which also makes the depth-2 `*-undefined-own`
    template (`[[undefined]]` → outer rewires, inner `[undefined]` builds
    `externref` on its own) work without extra plumbing.

### Wasm/IR shape (after the fix, `for (const [x = 23] of [[undefined]])`)

```
;; OUTER subject vec:  (ref $__vec_ref_<innerExtVec>)  — was (ref $__vec_i32)
;;   inner [undefined]: $__vec_externref { length=1, data=[ <undefined externref> ] }
;; for-of element read → elemLocal : (ref $__vec_externref)
;; Vec-array destructure, element 0, innerElemType = externref, wantUndefinedSentinel = true:
local.get $innerData
local.get $i                       ;; = 0
;; emitBoundsCheckedArrayGet(..., useUndefinedSentinel=true):
;;   in-bounds  → array.get  (yields the undefined externref)
;;   (ctx.usesArrayHoles && externref) → $Hole→undefined map  [hole template only]
;; emitDefaultValueCheck(externref, x, init=23, target=f64):
local.tee $dflt
;;   __extern_is_undefined($dflt)?  → then: x = (f64)23   else: x = unbox($dflt)
```

No new opcodes, no new imports beyond `__get_undefined` (already wired via
`ensureGetUndefined`, `array-methods.ts:411-413`) and the `$Hole` machinery
(already present). The entire read path is **unchanged**.

### Why NOT the tuple candidate (Mechanism A in the issue)

Routing the inner literals through `compileTupleLiteral` works for the exact
templates but has a latent **arity gap**: the tuple-destructure branch breaks at
`if (i >= tupleFields.length) break;` (`loops.ts:1620`), so a pattern with MORE
elements than the inner tuple (`for (const [a, b = 5] of [[1]])`) would silently
skip `b`'s default. The tuple struct is also fixed-arity, so holes/short inner
arrays don't get the bounds-checked OOB→undefined behaviour the vec path gives
for free. The `externref`-vec carve reuses the bounds-checked
`wantUndefinedSentinel` path, which already handles arity mismatch, holes, and
the assignment-form RequireObjectCoercible throw — strictly more robust for the
same (smaller) change.

### Edge cases / invariants

- **Signedness of a typed view** — *not applicable here*. This is plain-array
  element representation, not a TypedArray OOB read; the adjacent
  `emitTypedArrayUndefinedOobGet` / `emitPlainArrayUndefinedOobGet`
  (`property-access.ts`) threads view signedness for `a[i]` OOB reads, but the
  for-of subject is a normal `__vec`, so no `get_s`/`get_u` choice arises. Listed
  for cross-reference only; the spec deliberately does **not** touch
  `property-access.ts`.
- **hole vs undefined vs 0** — after the carve, `0` no longer appears for the
  absent slot: an explicit `undefined` element stores the `undefined` externref;
  a hole stores `$Hole` and maps to `undefined` on read; a real `0`/value in a
  non-undefined inner array keeps its numeric backing (the predicate excludes
  `number[]`). The default fires **only** on `undefined`/`$Hole`, never on a real
  `0` (which never enters this externref-backed path).
- **Interaction with the OOB path** — `wantUndefinedSentinel` already handles the
  *OOB* case (`for (const [a = 9] of [[]])`, empty inner → OOB → `__get_undefined`
  → default). This change makes the *in-bounds* `undefined`/hole case take the
  same branch, so both in-bounds-undefined and OOB-undefined now route through
  one mechanism. No double-default risk: `emitBoundsCheckedArrayGet` yields a
  single externref (in-bounds value or OOB undefined), and `emitDefaultValueCheck`
  runs once.
- **Runtime iteration concerns the issue raised** (length/break/continue/
  closures-per-iteration): unaffected. The OUTER container is still a `__vec` of
  refs — only the inner element STRUCT changes from `__vec_i32` to
  `__vec_externref`. Loop length, `break`/`continue` block depths, and
  per-iteration binding freshness all operate on the outer vec exactly as before.
- **Non-default for-of over an undefined array literal** (`for (const [x] of
  [[undefined]])`, no default) is **not** in scope and is **not** regressed: the
  gate (`forOfDstrNeedsInboundsUndef`) requires a default/nested sub-pattern, so
  this case keeps its current `__vec_i32` backing (still byte-identical; `x`
  stays `0` as today — a separate, unlisted concern).
- **Mixed inner arrays** (`[[1], [undefined]]`): out of scope. TS widens the
  element type to `(number | undefined)[]` → `f64` (union-unwrap drops
  `undefined`, `type-mapper.ts:90-99`) → `__vec_f64`, where the existing f64 sNaN
  path already works without this carve. The predicate's
  `Undefined|Void`-flag check won't fire for a `number|undefined` element, so
  mixed literals are untouched.

### Existing helpers to REUSE (no new runtime helpers)

- `getOrRegisterVecType(ctx, "externref", { kind: "externref" })` — the canonical
  externref-vec key (same one the inner literal already builds with), so the
  outer element type matches the inner with no coercion.
- `emitBoundsCheckedArrayGet(..., useUndefinedSentinel=true)` (`array-methods.ts:386`)
  — already reached via the Vec branch's `wantUndefinedSentinel`
  (`loops.ts:1862-1875`); no change.
- `emitDefaultValueCheck` externref arm (`statements/destructuring.ts:625-635`) —
  `__extern_is_undefined` default-check; no change.
- `emitHoleToUndefined` / `$Hole` (`array-holes.ts`) — in-bounds hole→undefined
  read-boundary map; no change.
- `_isUndefinedLike` (`literals.ts:92`) — reuse in the new predicate.

The only NEW code is the gate helper `forOfDstrNeedsInboundsUndef`, the predicate
`innerVecElemKindIsI32DueToUndef`, and the two scoped flag toggles. No new
opcode, no new import, no read-path edit.

### Scoped repro (`.tmp/`, standalone-safe)

```ts
// .tmp/repro-2769.ts
let n = 0;
for (const [x = 23] of [[undefined]]) { if (x !== 23) throw new Error("undef:" + x); n++; }
for (const [y = 23] of [[,]])         { if (y !== 23) throw new Error("hole:" + y); n++; }
// in-bounds real value must NOT fire the default:
for (const [z = 23] of [[7]])         { if (z !== 7)  throw new Error("real:" + z); n++; }
// OOB (already passes today) must still fire:
for (const [w = 9]  of [[]])          { if (w !== 9)  throw new Error("oob:" + w);  n++; }
if (n !== 4) throw new Error("count:" + n);
```
Compile + run via the equivalence harness (JS-host AND `--target wasi`/standalone
both, since the carve is pure value-rep). The two `*-undefined-own` assignment
templates are conformance-only (TypeError); validate those via test262, not the
inline repro.

### Test files to verify (test262)

Binding `id-init` (must flip fail→pass, `x === 23`):
- `language/statements/for-of/dstr/{const,let,var}-ary-ptrn-elem-id-init-undef.js`
- `language/statements/for-of/dstr/{const,let,var}-ary-ptrn-elem-id-init-hole.js`

Assignment `*-undefined-own` (must throw `TypeError`):
- `language/statements/for-of/dstr/array-elem-nested-array-undefined-own.js`
- `language/statements/for-of/dstr/array-elem-nested-obj-undefined-own.js`
- (and the sibling `array-rest-nested-*-undefined-own.js`,
  `obj-prop-nested-*-undefined-own.js` in the same dir — confirm in the run)

### Regression guard & sequencing

- **Validate the full `merge_group` / test262 floor, NOT a scoped sweep** — the
  PR #2226 regressions surfaced ONLY in merge-group re-validation. Particularly
  watch `built-ins/Array/**` construction/consumer tests
  (`S15.4.2.1_A2.1_T1`, `sort/S15.4.4.11_A1.3_T1`, `S15.4.1_A2.1_T1`,
  `reduceRight/15.4.4.22-8-c-4`): the gate (`ts.isArrayLiteralExpression(subject)
  + for-of + destructuring-with-default/nested`) means none of those
  construction/consumer paths can be reached, so they must stay green —
  confirming the carve did NOT leak into the global `undefined[]` backing.
- **No `resolveWasmType` change** — the carve lives entirely in
  `compileArrayLiteral` behind the for-of-only flag, so the type-determinism
  invariant that broke PR #2226 is preserved.
- **Parallel-session conflict check:** the active parallel session works on
  `$Object` / any-receiver dispatch / `calls.ts` / acorn / diff-test. This spec
  touches only `src/codegen/statements/loops.ts` and `src/codegen/literals.ts`
  (and optionally one field in `context/types.ts`) — **no overlap** with
  `calls.ts`, the `$Object` substrate, the any-receiver dispatch slices, acorn,
  or the diff-test harness. `literals.ts` is large/central; the change is a small
  insert right after `3244` and is unlikely to collide, but re-merge `origin/main`
  before enqueue and re-run the floor if `literals.ts` moved. **No dependency on
  the substrate work** — this carve is self-contained value-rep and can land
  independently in either order.
