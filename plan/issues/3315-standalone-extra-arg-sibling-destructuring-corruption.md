---
id: 3315
title: "standalone codegen: adding a 2nd argument to a call inside an object-method silently CORRUPTS sibling destructured bindings in the enclosing method (wrong values, no crash)"
status: done
completed: 2026-07-17
assignee: ttraenkler/fable-a419
created: 2026-07-16
priority: high
feasibility: hard
reasoning_effort: max
task_type: bug
area: codegen-standalone
goal: standalone
sprint: 72
related: [3285, 3104, 2379, 2873]
# (#3102/#3131) Intended growth: the fix lands in the modules that own the
# broken logic (rep decision, coercion arm, destructure conversion loop,
# identifier narrowing skip) — moving it out would split one mechanism
# across new files for no cohesion gain.
loc-budget-allow:
  - src/codegen/destructuring-params.ts
  - src/codegen/type-coercion.ts
  - src/codegen/context/types.ts
  - src/codegen/expressions/identifiers.ts
---

# #3315 — extra call-argument corrupts sibling destructuring in standalone methods

## Problem (SILENT WRONG ANSWERS — worse than a crash)

In `--target standalone`, changing a call INSIDE an object-literal method from
one argument to two arguments silently changes the VALUES of unrelated
destructured bindings in that same method. No trap, no exception — the
destructured variable simply holds the wrong value. Found while landing
PR #3104 (#3285's `assert_throws(ErrorCtor, fn)` two-arg shim): the enclosing
method's `{ w: [x, y, z] = [4, 5, 6] }` param, invoked with
`{ w: [7, undefined, ] }`, yields a corrupted `y` (should be `undefined`) —
**purely because a later statement in the method passes a second argument to a
function call.**

This is a general codegen bug, NOT an assert_throws/test262-shim issue — the
shim merely exercises it. Verified triggers (A/B, deterministic, 2026-07-16):

| call shape in the method body                           | `y` after destructuring |
| ------------------------------------------------------- | ----------------------- |
| `f(fn)` (v3 shim, 1 arg)                                | correct (`undefined`)   |
| `f(SomeClass, fn)` (class value + fn)                   | **corrupted**           |
| `f(someDummyClass, fn)` (unrelated local class + fn)    | **corrupted**           |
| `f(matcherClosure, fn)` (2 function values)             | **corrupted**           |
| `__g = SomeClass; f(fn)` (global CTOR-value assignment) | **corrupted**           |
| `__g = "name"; f(fn)` (global STRING assignment)        | correct (`undefined`)   |

So the trigger is broader than call arity: a class-as-VALUE anywhere in the
method body (2nd call argument, matcher closure argument, or a plain global
assignment of the ctor) corrupts the sibling bindings; a string-literal
global assignment plus the v3 single-argument call is the only
validated-clean shape of those tried. (A 2-function-value call also corrupts,
so "extra callable argument" is a second axis — characterize both.)

## Deterministic repro (full-file; minimal repros do NOT fire — see below)

- Test: `test262/test/language/expressions/object/dstr/meth-obj-ptrn-prop-ary.js`
  (corpus SHA 63829c6d92) wrapped by `wrapTest(src, meta, "standalone")`.
- Driver: `.tmp/probe-driver.mts` from the #3104 landing session — wrap +
  `compile({ target: "standalone" })` + `buildImports` + run `test()`:
  - main's wrap (1-arg `assert_throws(fn)`): `RET = 1` (pass).
  - #3104's wrap (2-arg `assert_throws(ReferenceError, fn)`): `RET = 3` —
    fails `assert.sameValue(y, undefined)` (assert #2). The ONLY wrapped-source
    difference is the shim signature + call shape; the sameValue asserts and
    the destructuring are byte-identical. Compiler tree = current main
    (PR #3104 touches zero `src/**`).

**Distillation attempts did NOT reproduce** (important diagnostic): a small
standalone file with the same method-shape + 2-arg call (`min1`) and a
faithful shim+asserts reduction (`min2`) both destructure correctly. The
corruption therefore depends on the LARGER compilation context (the full
test262 preamble: many classes/closures/helpers) — consistent with the known
type-index / rep-decision / RTT-ordering fragility class
(`project_type_index_shift_and_deadelim`,
`reference_2873_funcref_wrapper_chain_rtt_order`,
`reference_2379_new_array_n_boxed_any_elem_rep`): the extra argument
presumably shifts a type/rep decision that the array-destructuring-with-holes
lowering is sensitive to. Whoever picks this up should bisect the preamble
(delete helpers until the flip stops) to find the context ingredient, then
reduce.

## Scope guidance (from the 2026-07-16 review)

1. **Characterize the trigger broadly before scoping narrowly.** The verified
   surface is "2-arg call in an object-method with array-destructuring
   defaults + holes in its params", reached via one caller (the test262 shim).
   The REAL surface is plausibly much bigger: any standalone method whose
   compilation crosses the same rep/type-layout sensitivity. Check whether
   sibling-LOCAL corruption (not just params) occurs; check plain functions vs
   object methods; check the sensitivity to preamble contents.
2. **Latent corpus damage**: pre-existing standalone test262 failures ON MAIN
   may already exhibit this signature (wrong destructured values) without ever
   having flipped — they were never diagnosed because nothing changed. A scan
   of standalone `fail` rows whose failing assert is a `sameValue`
   on a destructured binding could find undiagnosed instances.
3. **Fix the corruption, full stop.** Do NOT scope this to "make the
   assert_throws shim avoid the shape" — #3104 works around the trigger
   (side-channel single-arg shim, see #3285's landing notes), but the
   underlying bug still silently mis-executes user code.

## Related observed fragility (same session, likely same substrate)

- Error-identity semantics in standalone are CONTEXT-DEPENDENT: in one
  compilation context, `new ReferenceError("x")` matched neither
  `e instanceof ReferenceError` nor `.name === "ReferenceError"` after
  throw/catch (min2), while in another context `new TypeError("m")` satisfied
  BOTH `instanceof` and `.name` (min3) and a RUNTIME-thrown unresolvable
  reference carried `.name === "ReferenceError"` correctly (side-channel
  probe) while a runtime-thrown property-access-on-undefined did NOT carry
  `.name === "TypeError"` (min3). Same class of context-sensitivity; may
  share the root cause or split into its own issue during diagnosis.

## Root cause + fix (fable-a419, 2026-07-17)

The corruption is the compiler's undefined-in-f64 handling breaking down at
THREE stacked layers for parameter array-pattern bindings. The minimal shape
now reproduces deterministically on current main (both lanes — the issue's
"distillation does not fire" no longer holds):

```ts
var obj = { method({ w: [x, y, z] = [4, 5, 6] }) { /* y === undefined? */ } };
obj.method({ w: [7, undefined, ] });   // y !== undefined, z !== undefined (pre-fix)
```

1. **Rep layer** — the element bindings x/y/z have NO per-element default, so
   a runtime `undefined` can flow into them; but their checker type is
   `number` (inferred from the pattern's own `[4, 5, 6]` default — a fiction
   never constrained by actual JS callers). `resolveBindingElementType`
   resolved that to an f64 local; storing `undefined` degraded it to NaN and
   `y === undefined` constant-folded to false (binary-ops scalar arm).
   **Fix**: widen PARAMETER array-pattern elements (no per-element default,
   f64-resolved) to externref locals (`src/checker/type-mapper.ts`,
   `isUndefWidenedBindingElement`), registered in `fctx.undefWidenedLocals`;
   identifier reads of these skip the checker-type unbox narrowing
   (`src/codegen/expressions/identifiers.ts`). Scoped to parameters — decl
   destructuring infers element types from the ACTUAL initializer (e.g.
   `var [a, b] = [7, undefined, ]` already types `undefined` in) and keeps
   its numeric reps (for-of perf idioms untouched). Native `i32` annotations
   keep their explicit opt-in rep.

2. **Box layer** — `[7, undefined, ]` deliberately lowers to an f64 vec with
   `undefined` as the UNDEF_F64_BITS signaling-NaN sentinel (#1024,
   value-tags.ts). Three boxing sites turned that sentinel into a boxed
   NUMBER NaN (undefined identity lost): the generic coerceType
   f64→externref arm (`src/codegen/type-coercion.ts`), the destructure
   vec-conversion loop (`boxToExternref`,
   `src/codegen/destructuring-params.ts`), and the host read boundary
   (`__vec_get`, `src/codegen/vec-access-exports.ts` — where
   `__make_iterable`'s convertToJS reads elements; the JS side cannot
   recover the sentinel). All three now map sentinel-bits → real `undefined`
   (host `__get_undefined` / standalone tag-1 singleton) before boxing —
   the same observer discipline as the existing `$Hole → undefined` map
   (#2001) and the standalone any-box `$BoxedNumber`-sentinel arm (#2979).
   JS arithmetic only produces the quiet NaN 0x7FF8…, never the signaling
   sentinel, so genuine computed NaNs still box as numbers.

3. **Context sensitivity** (the issue's 1-arg vs 2-arg A/B) — which
   destructure arm fires (f64-tuple / heterogeneous tuple / f64-vec /
   host-array fallback) shifts with compilation context; each arm had a
   different subset of the broken boxing sites, so an unrelated class-value
   argument flipped the observable. With all sites fixed the shapes agree.

## Test Results (fable-a419, 2026-07-17)

- Acceptance probe pair (wrapTest'd `meth-obj-ptrn-prop-ary.js`, y/z
  undefined-asserts REINSTATED — stronger than the corpus wrap): 1-arg and
  2-arg shapes both **pass** on host AND standalone (pre-fix: both fail).
- `tests/issue-3315.test.ts`: **10/10** — direct `===` compare, any-param
  isSameValue (harness shape), class-as-value 2nd arg, whole-pattern default
  still fires, ToNumber arithmetic semantics; each on host + standalone.
- Scoped sweep: 280 dstr-family test262 files × both lanes (560 lane-runs),
  branch vs origin/main control: **zero status diffs**.
- `tsc --noEmit`: clean.
- Latent-corpus scan (scope guidance 2): standalone baseline has 9,595
  `fail` rows with assert-family errors; **803** of those are dstr-path
  files (superset of the #3315 signature — includes unrelated async-gen /
  iterator-error clusters). The `sameValue(_, undefined)`-on-destructured-
  binding subset is the improvement pool; the PR's CI regression diff is the
  authoritative re-measure (acceptance item 3).
- Adjacent-idiom spot probes (host + standalone, branch vs main control):
  optional-param `?:` zero-default (pre-existing, unchanged), real-NaN
  element does NOT become undefined (sentinel is a signaling NaN; quiet
  computed NaNs box as numbers), array hole read (**host fixed** by this PR
  — was 0 on main), for-of pair destructuring unchanged, function
  array-pattern param with short arg (**standalone fixed** by this PR; host
  still wrong on main AND branch — pre-existing residual, see below).

## Residual (out of scope, pre-existing)

`function g([p, q]: number[]) …; g([7])` on the HOST lane still reads
`q === undefined` as false (typed ref-vec param destructure path — the
direct-ref arm at the tail of `destructureParamArray`, distinct from the
externref arms fixed here). Standalone is fixed by this PR. Same signature
family; needs its own slice through the typed-vec OOB read.

## Acceptance criteria

- Root cause identified and fixed: the probe pair (1-arg vs 2-arg wrapped
  `meth-obj-ptrn-prop-ary.js`, standalone) destructures identically and
  correctly in both shapes.
- A regression test pinning the trigger (once reduced) in `tests/`.
- The #3285 landing notes' 191 standalone-only / 24 host sameValue-family
  flips re-measured after the fix — they should disappear from the flip set
  once the shim rework (#3104) and this fix are both in.
- Scan for latent corpus instances per scope-guidance (2) — report count.

## Regression fix — merge_group park on PR #3182 (2026-07-17)

The first cut of this PR auto-parked on the `check for test262 regressions`
gate (JS-host lane, merge_group): `Math/log2/log2-basicTests.js` assert #8
(`Math.log2(undefined)` must be NaN) flipped `pass → fail`, boxing to
`undefined` instead of a NaN number.

Root cause: the fix's sentinel-aware boxing was added to the **generic**
`f64 → externref` arm in `type-coercion.ts` on the premise "JS arithmetic
only produces the quiet NaN `0x7FF8…`, never the signaling sentinel." That
premise fails for the self-hosted Math family — its NaN fast-path
(`if (x !== x) return x;` in `src/stdlib/math.ts`) and the payload-preserving
`f64.abs` bit-op return the input `UNDEF_F64_BITS` bits unchanged. So a genuine
numeric NaN (`ToNumber(undefined) = NaN`) reached the generic box carrying the
sentinel and was wrongly resurrected to `undefined`. Confirmed scope: log2,
abs, sin, cos, exp, log, log10, tanh, cbrt (self-hosted family); `Math.sqrt`,
`Math.floor`, `Number(undefined)`, `+undefined`, `parseFloat` were already
correct (canonicalizing ops / host). Not broader than the Math family.

Fix: the generic `f64 → externref` arm no longer intercepts the sentinel — an
arbitrary computed f64 is a NUMBER and boxes as one. Undefined **identity** is
still preserved at the dedicated identity-carrying-slot boxing sites (the
destructure vec read-back in `vec-access-exports.ts`, the `undefWidenedLocals`
externref path, and the standalone any-box tag-1 recovery in
`any-helpers.ts`). Verified: log2-basicTests passes, all 10 of
`tests/issue-3315.test.ts` pass, `[7, undefined]` array-element identity
preserved, whole Math family boxes to NaN-number, genuine computed NaNs stay
numbers.
