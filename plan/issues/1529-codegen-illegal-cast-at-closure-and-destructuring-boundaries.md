---
id: 1529
title: "codegen: 'illegal cast' umbrella at closure & destructuring parameter boundaries"
status: done
created: 2026-05-20
updated: 2026-05-20
completed: 2026-05-28
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: type-coercion, destructuring, closures, wasm-gc
sprint: 56
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

## Implementation Plan (architect, 2026-05-28)

### Root cause (umbrella, three distinct cast sites)

The umbrella name "illegal cast at closure & destructuring boundaries"
covers **three** physically distinct `ref.cast` / `ref.cast_null` emitters
in current codegen, all of which can trap because the dynamic heap type
of the input is not statically guaranteed to be a subtype of the declared
`typeIdx`. Each site needs the same kind of fix — *replace unguarded cast
with the established guarded pattern* — but the receiving local types
and the spec-correct fallback differ. The three sites in order of test262
weight on the ~241-fail cluster:

#### Site C1 — capture-struct extraction in JS-host callbacks (`src/codegen/closures.ts:2467`)

```ts
// L2461-L2468  __cb_N body prologue
cbFctx.body.push({ op: "local.get", index: 0 });           // __captures: externref
cbFctx.body.push({ op: "any.convert_extern" });             // anyref
cbFctx.body.push({ op: "ref.cast", typeIdx: capStructTypeIdx });  // unguarded
cbFctx.body.push({ op: "local.set", index: capLocal });
```

This is the entrypoint of every `__cb_N` (the callback lifted from an
arrow used as a JS host argument: `arr.map(x => ...)`, `arr.forEach(...)`,
`Promise.then(...)`, etc.). The host hands the captures back as an
externref. The cast assumes that externref is the *same* `__cb_cap_N`
struct that was packed at the creation site. Two things break it:

1. **Cross-callback collision in async/generator suites.** When the same
   compiled module instantiates multiple callback shapes through the
   shared `__make_callback` host bridge and an unrelated callback's
   capture externref reaches a different `__cb_N` (e.g. via the
   `assert_throws` indirection, where the inner `function () { ... }`
   is itself a callback whose captures are the assertion's local
   bindings, not the outer test's), the cast traps.
2. **Wasm-side closures from `compileLiftedArrow` reused as host args.**
   When a closure originally lifted for in-Wasm `call_ref` is later
   passed as an externref to a host import that re-enters the module
   through `__cb_N`, the captures externref points at the lifted closure
   struct (`__closure_N`), not at a `__cb_cap_N` struct, and again the
   cast traps.

This is the dominant `__closure_N() ← assert_throws ← test` shape
(~90 of the 241 fails per the issue's distribution table).

#### Site C2 — wrapper-struct downcast in lifted closures (`src/codegen/closures.ts:1642`)

```ts
// L1639-L1644 lifted-arrow body prologue (only when usesWrapperFuncType=true)
liftedFctx.body.push({ op: "local.get", index: 0 });                   // __self: wrapper base
liftedFctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx } as Instr); // unguarded
liftedFctx.body.push({ op: "local.set", index: castLocal });
```

When closures are dispatched through a shared wrapper func type (the
multi-funcref-dispatch family — see #1693), `__self` enters as `ref
$__wrapper_base` and the body downcasts it to the specific subtype to
access this closure's captures. Two callable closures of the same arity
that flow through the same call site (the `o.fn1 = arrow1; o.fn1 =
arrow2; o.fn1();` shape) share the wrapper func type, but the dynamic
`__self` may be the *other* subtype on a given call. This is the
secondary fingerprint behind the `C_method()` ~70 bucket when classes
hold accessor-only callable fields.

#### Site C3 — `ref.cast` / `ref.cast_null` in destructuring default-init (`src/codegen/statements/destructuring.ts:363, 365, 606`)

```ts
// L362-L366 — externref-then-non-undefined branch of dstr default
fctx.body.push({ op: "any.convert_extern" });
if (fieldType.kind === "ref") {
  fctx.body.push({ op: "ref.cast", typeIdx: ... } as Instr);            // unguarded
} else if (...) {
  fctx.body.push({ op: "ref.cast_null", typeIdx: ... } as Instr);       // unguarded
}
```

```ts
// L605-L607 — struct-typed object-destructure receiver
if ((resultType as { typeIdx?: number }).typeIdx !== structTypeIdx) {
  fctx.body.push({ op: "ref.cast", typeIdx: structTypeIdx });           // unguarded
}
```

These fire on the dstr default-init pathway when the RHS is an
`externref` whose actual heap shape is not the declared `fieldType.typeIdx`
of the consumer (or, at L606, when an object-literal RHS's anonymous
struct type doesn't match the destructuring pattern's expected struct
shape). This is the `fn() ← test` ~50 bucket (for-of / for-await-of value
binding) plus the `meth-static-obj-ptrn-list-err` family. Note that
#820d (task #68) already fixed the most acute async-gen-meth variant by
broadening one branch's externref handling, but the underlying unguarded
casts at L363/L365 remain.

### Fix approach — *coerce safely at the receive site, never trap*

For each site, replace the raw `ref.cast` with **the existing
`emitGuardedRefCast` pattern** (`src/codegen/type-coercion.ts:25`) and
make the failure path spec-correct rather than `ref.null`. The guarded
pattern is:

```
local.tee $tmp_any (anyref)
ref.test  $T
if (result ref null $T)
  local.get $tmp_any
  ref.cast_null $T          ;; succeeds — ref.test just returned true
else
  ref.null $T               ;; current behaviour (silent null)
                            ;; → REPLACE with: throw TypeError per spec section
end
```

The current `emitGuardedRefCast` pushes `ref.null $T` on the else branch.
That is the right *primitive*, but each call site needs a spec-correct
post-action because a silent null produces downstream `null deref`
failures (the second-largest fingerprint bucket). The post-action varies
by site:

| Site | Else-branch spec-correct action |
|---|---|
| **C1** (capture extraction) | This is an *internal* invariant violation, never user-observable. If the externref isn't the expected capture struct, the calling host bridge produced a wrong dispatch. Replace the trap with an `unreachable` (or call into `__throw_internal_error("__cb_N: bad capture struct")` under a debug flag); production codegen emits `unreachable` so the trap is the same shape as today but with a clear callsite. **Fix is a no-op for spec compliance** — these traps shouldn't be reachable from valid user code; they fire today because the *dispatch* is wrong (Sites D1 / D2 below). |
| **C2** (wrapper downcast) | Same as C1 — internal invariant. If the wrapper's `__self` is the wrong subtype, the wrapper-call dispatch is mis-targeting the closure. `unreachable` on the else branch; the *real* fix is at the dispatch site (D1). |
| **C3** (dstr default-init `ref.cast` at L363/L365/L606) | This *is* user-observable: a JS source like `({ a } = x)` where `x` is an object of the wrong shape must NOT trap — per §13.15 DestructuringAssignmentEvaluation, the access just yields `undefined`. Replace the unguarded cast with the guarded pattern PLUS an `extern.convert_any` + `__extern_is_undefined` short-circuit so the destructuring continues through the externref-fallback path (`compileExternrefObjectDestructuringDecl`) when the cast fails. No trap, no TypeError — just route through the slower-but-correct externref path. |

### Two upstream dispatch fixes that drive most of the cluster (Sites D1, D2)

The C1/C2 traps fire because the dispatch is wrong. The root-cause fixes
are at:

#### Site D1 — `__make_callback` dispatch table identity (`src/codegen/closures.ts:2613-2622`)

When a single module registers multiple `__cb_N` callbacks, the host
bridge picks one by `cbId` and hands it the captures externref it
received from the JS-host call. The bug: if the captures externref
*belongs to* a different callback (cross-callback contamination through
nested `assert_throws(ReferenceError, function () { ... })` where the
inner function is itself a `__cb_M`), `__make_callback` dispatches with
the right `cbId` but the wrong captures externref.

**Fix**: tag the captures struct at pack time with a `cbId` discriminator
(extend `__cb_cap_N` with an `(field $cb_id i32)` prefix, set to `cbId`
in `__make_callback` site emission), and dispatch on it at unpack. The
`ref.test $T` on the externref already covers the *type* mismatch
(externref → wrong struct shape), but adding the discriminator gives a
dispatcher-level guarantee: a wrong-cbId captures struct is detected
*before* the cast and routed to the right callback. This collapses Site
C1's `unreachable` to a hard "should never fire" invariant.

#### Site D2 — wrapper-func dispatch capability test (`src/codegen/closures.ts:1280-1330`, the wrapper-cast emit site)

When two callable closures of the same arity share a wrapper func type,
the wrapper-call site must look at the funcref slot of the *actual*
`__self` (not the static type) and dispatch through `call_ref` of the
specific subtype's funcTypeIdx. The current path types `__self` as
wrapper-base, which is correct for the funcref load (`struct.get
$__wrapper_base.0`), but the body still does the wrong-subtype cast at
L1642. **Fix**: drop the L1642 downcast entirely and rewrite the
captures extraction at L1646-L... to read fields through *generic*
accessors on the wrapper base struct rather than typed `struct.get` on
the subtype. The wrapper-base captures field is already a `ref null
$any_caps` shape — the per-subtype captures struct is reachable as a
second-level cast that *can* be guarded (then route to the per-subtype
captures unpack). Equivalent: have each subtype expose a *typed* unpack
function that the wrapper-base trampoline `call_ref`s into, instead of
inlining the cast.

### Affected functions (summary)

| File | Function | What changes |
|---|---|---|
| `src/codegen/closures.ts` | `compileLiftedCallback` (lines ~2300-2620, `__cb_N` emitter) | L2467: replace raw `ref.cast` with guarded pattern; else-branch `unreachable`. Add `cbId` discriminator to `__cb_cap_N` and verify in unpack. |
| `src/codegen/closures.ts` | `compileLiftedArrow` (lines ~1393-1860, wrapper-func path) | L1642: drop downcast OR replace with guarded pattern; refactor captures extraction to per-subtype trampoline (`__cb_unpack_$N`). |
| `src/codegen/statements/destructuring.ts` | `emitDefaultInitObjectProperty` (L340-L438) | L363/L365: replace raw `ref.cast`/`ref.cast_null` with `emitGuardedRefCast` (already imported via type-coercion.ts); else branch routes through `compileExternrefObjectDestructuringDecl` instead of `ref.null`. |
| `src/codegen/statements/destructuring.ts` | `compileObjectDestructuring` (L441-...) | L606: same guarded-pattern replacement; else branch falls through to the existing externref-fallback at L466-L468 (re-walks `pattern` via `compileExternrefObjectDestructuringDecl`). |
| `src/codegen/type-coercion.ts` | `emitGuardedRefCast` (L25-L41) | No change — already the canonical primitive. The four callers above adopt it. |

### Wasm validation rules to satisfy

For each guarded-cast replacement, the emitted `if` block's
`blockType` MUST be a `ref null $T` value type (matching the consumer
local's type). The `then` branch pushes `ref.cast_null $T` (always
succeeds — guarded by `ref.test $T`). The `else` branch pushes either
`ref.null $T` (current fallback) or `unreachable` (for C1/C2 internal
invariants, since `unreachable` has bottom type and unifies with any
expected type). For C3's externref-fallback route, the `else` branch
needs to **not push a `ref null $T`** at all — instead, restore the
externref on the stack and `br` out of the destructuring block to the
externref-fallback path. The cleanest expression is to extract the
guarded cast + fallback into a small helper:

```ts
function emitGuardedRefCastOrFallback(
  ctx, fctx, typeIdx: number,
  fallbackInstrs: Instr[],   // emitted in the else branch (must produce same result type)
  resultType: ValType,       // the block type (typically ref null $T)
): void { ... }
```

…and the dstr-fallback path passes `compileExternrefObjectDestructuringDecl`-equivalent instrs
in `fallbackInstrs`. This keeps the cast/fallback co-located and lets the
two destructuring sites (L363/L365 and L606) share the same primitive.

### Edge cases

1. **`hasTdzFlag` captures (`nested-declarations.ts:283`).** The comment
   at L283 already warns that the externref → ref coercion can emit a
   `ref.cast_null` + `ref.as_non_null` that traps. The guarded-pattern
   adoption in `emitDefaultInitObjectProperty` (C3 fix) does NOT cover
   this path — it lives in `compileForOfAssignDestructuringExternref`
   (`src/codegen/statements/loops.ts:1364`-ish). Audit that emit site and
   apply the same guarded pattern. Listed as **Sub-cluster D** for the
   for-await-of `fn() ← test` ~50 bucket.

2. **`__lastGuardedCastBackup` consumer (`type-coercion.ts:40`).** The
   primitive stashes the pre-cast anyref so downstream multi-struct
   dispatch (#792) can use it when the cast produced null. The Sites
   C1/C2 callers DON'T need this backup (their else branch is
   `unreachable` — there's nothing downstream to recover). Sites C3 DO
   need it: the externref-fallback path expects an externref on the
   stack, which can be reconstructed from the stashed anyref via
   `extern.convert_any` (see `coerceType` for the reverse direction).

3. **Multi-struct accessor dispatch (#860, PR #819 in flight).** The
   wrapper-struct cast at L1642 may have additional callers beyond the
   compileLiftedArrow path. Cross-check `usesWrapperFuncType` consumers
   and audit each call site. Coordinate with the in-flight PR #819.

4. **Default-init field is `ref` (non-null) but the cast yields `ref null
   $T`.** The current code's `if (fieldType.kind === "ref")` branch at
   L362 still calls `ref.cast` (non-null), which would fail validation
   if the guarded pattern's `then` branch pushes `ref.cast_null` (which
   IS nullable). Add a `ref.as_non_null` after the if-block when the
   target slot is non-null and we provably came from the then branch
   (typed `(ref null $T)` reduces to `(ref $T)` via `ref.as_non_null`).
   For sites where the else branch may produce null, the receiving local
   must be widened to `ref null $T` and a separate null-check + spec
   TypeError throw added.

5. **`__cb_cap_N` discriminator backward-compat.** Adding a `cbId`
   prefix field to every capture struct is a layout change — every
   previously-emitted `__cb_N` body's `struct.get` indices shift by +1.
   Either prefix the field AND update every `struct.get fieldIdx` in
   the emitter (mechanical), or use a parallel global table mapping
   captures externref → cbId. The field-prefix approach is cleaner.

6. **The capture-struct dispatch fix (D1) is a behaviour change for
   `__make_callback` users.** External user code that hand-constructs a
   captures externref and hands it to `__make_callback` (does not happen
   in compiled output, but the host bridge surface is public) breaks.
   Acceptable — `__make_callback` is internal.

### Suggested implementation order (incremental, each lands independently)

1. **Slice 1 — Site C3 (dstr default-init guards, ~50 fails of the
   "fn() ← test" cluster).** Smallest, no D-site dependency, no layout
   change. Spec-correct: routes through externref fallback on cast
   miss. Adopts `emitGuardedRefCastOrFallback` helper. *Estimated +30
   to +50 test262 net.*

2. **Slice 2 — Site C1 with `unreachable` else (~30 fails of
   `__closure_N() ← assert_throws`).** Adopts guarded cast at L2467,
   emits `unreachable` else (matches current trap shape but at the
   *right* callsite, no further damage). *Estimated +10 to +20.*

3. **Slice 3 — Site D1 (capture-struct `cbId` discriminator).** The
   real fix for C1's underlying mis-dispatch. Layout change, all
   `__cb_cap_N` `struct.get` indices shift by +1. *Estimated +40 to
   +60.*

4. **Slice 4 — Sites C2 + D2 (wrapper-func dispatch).** Coordinate
   with #1693 / PR #819 (multi-funcref-dispatch). Refactor wrapper-base
   captures access to per-subtype trampoline. *Estimated +30 to +50.*

5. **Slice 5 — Sub-cluster D (for-await-of `emitCoercedLocalSet`
   guarded path).** The `nested-declarations.ts:283` warned-about
   ref.cast_null. *Estimated +20 to +30.*

### Out of scope (do NOT pull into this issue)

- **Multi-funcref-dispatch core fix (#1693).** Sites C2/D2 *adopt* the
  refactor that #1693 prescribes; they don't drive it.
- **#860 closure-as-property-value wrapping (PR #819).** Sites C2 may
  touch the wrapper struct emit site that PR #819 also edits; rebase
  ordering matters but the changes are orthogonal (D2 changes the
  *dispatch*, #860 changes the *property write*).
- **#1320 Array.from iterator bridge (Layer 3).** The for-of `fn() ←
  test` bucket overlaps with #1320 for *array* iterables; Slice 1
  fixes only the dstr-default cast path, not the iterator-protocol gap.
- **Spec TypeError throws for non-cast-related dstr failures (e.g.
  `({x:y}={x:undefined})` where `y` is non-null).** Out of scope —
  that's #821 / #1550 territory.

### Acceptance criteria refinement

The original "100 of 241" target is realistic for Slices 1+2 together.
Full ~241 recovery requires Slices 3 and 4, which are larger surgical
changes (D-site dispatch). Pin sub-slice owners separately when
dispatching the implementation tasks:

- `fix(#1529-c3-dstr-guarded-cast)` — Slice 1, **developer**.
- `fix(#1529-c1-cbN-guarded-cast)` — Slice 2, **developer**.
- `fix(#1529-d1-cbid-discriminator)` — Slice 3, **senior-developer** (layout change).
- `fix(#1529-c2-d2-wrapper-dispatch)` — Slice 4, **senior-developer** (coordinates with #1693).
- `fix(#1529-d-for-await-coerced-set)` — Slice 5, **developer**.

Each slice has its own minimal test in `tests/issue-1529-{slice}.test.ts`
(10-line reductions of the cited test262 cases).

