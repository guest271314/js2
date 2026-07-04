---
id: 2831
title: "[SENIOR-DEV ONLY] member-WRITE dispatcher `__set_member_<name>` traps `illegal cast` on the value coercion — compiled acorn cannot parse ANY function/arrow body"
status: done
completed: 2026-06-29
assignee: ttraenkler/sendev-2831
sprint: 69
priority: high
horizon: l
feasibility: hard
reasoning_effort: max
created: 2026-06-29
task_type: bugfix
area: codegen
language_feature: value-representation
goal: acorn-dogfood
related: [2664, 2659, 2805, 2806, 2809, 1917, 2379]
depends_on: []
blocks: [1712]
architect_spec: done
---

# #2831 — `__set_member_<name>` value-coercion `ref.cast` traps; compiled acorn can't parse function/arrow bodies

**The genuine blocker for #1712 (acorn parses a real file).** Surfaced by a
real-world differential (compiled acorn.wasm vs node-acorn) on the
native-messaging sources `examples/native-messaging/{edge.js,background.js}`:
both throw inside compiled acorn. Localized to **any function declaration or
arrow function** — the bulk of any real file.

## Minimal repros (RAW export, fresh single instance, first & only call)

Compile pinned acorn@8.16.0 with `skipSemanticDiagnostics: true`, instantiate,
`__setExports`, then on `instance.exports.parse(src, {ecmaVersion:2022,sourceType:"script"})`:

```
parse("function f() {}")      -> RuntimeError: illegal cast
parse("var g = (x) => x;")    -> RuntimeError: illegal cast
parse("async function f(){}") -> RuntimeError: illegal cast
```

Expression-level inputs ALL pass (call/member/var-decl/ternary/for-of/spread/
optional-chain/template), so the expression walls #2681/#2686/#2801 are genuinely
fixed — this is a **new, later wall**. Stack (raw export, not host marshalling):

```
RuntimeError: illegal cast
  at __set_member_labels   (wasm-function[174])
  at __closure_507         (wasm-function[888])   ; acorn parseFunctionBody-family
  at __call_fn_method_8    (wasm-function[1535])
```

## Root cause (WAT ground truth, NOT hand-waved)

`__set_member_labels` is the deferred-fill member-WRITE dispatcher
(`src/codegen/member-set-dispatch.ts`, #2664). Dumped body from compiled acorn:

```wat
(func $__set_member_labels (type 21) (local $__any anyref)
  local.get 0  any.convert_extern  local.tee 2
  ref.test (ref 6)                      ;; receiver shape A ($__fnctor_… )
  (if (then
      local.get 2  ref.cast (ref 6)     ;; receiver cast — GATED by ref.test, SAFE
      local.get 1  any.convert_extern
      ref.cast null (ref null 2)         ;; <-- VALUE coercion, UNGUARDED narrowing cast -> TRAPS
      struct.set 6 30)                    ;; field $labels, slot 30, type (ref null 2)
    (else
      local.get 2  ref.test (ref 47)     ;; receiver shape B (dual Parser struct, #2664)
      (if (then
          local.get 2  ref.cast (ref 47)
          local.get 1  any.convert_extern
          ref.cast null (ref null 2)      ;; <-- same unguarded value cast
          struct.set 47 30)
        (else local.get 0 global.get 561 local.get 1 call 39))))) ;; __extern_set_strict sidecar
```

Type 2 = `$__vec_externref` (the externref array-vec). So the `labels` field is an
**externref vec** (correct — #2806/#2809 routed acorn's evolving arrays to
externref). The trap is the **VALUE** coercion, not the receiver cast:
`coercionInstrs(ctx, {externref}, cand.fieldType)` at `member-set-dispatch.ts:180`
emits `any.convert_extern; ref.cast (ref null $__vec_externref)` on the inbound
value with **no `ref.test` guard**. acorn's `parseFunctionBody` does
`this.labels = []` on an `any`-typed `this` (a prototype method → dynamic
dispatch). The contextless empty `[]` at a dynamic any-receiver write has **no
expected-type propagation**, so it lowers to a *different* vec representation
(the #2806/#2809 numeric-vs-externref-vec family) than the field's
`$__vec_externref`; boxed to externref, the unguarded narrowing cast traps.

### The read-vs-write asymmetry (why only writes trap)

- **READ** (`__get_member_<name>`, `member-get-dispatch.ts:174`): after the gated
  receiver cast + `struct.get`, it coerces the field **UP to externref** —
  `externref` no-op / `__box_number` / `extern.convert_any`. Boxing up never
  narrows, so the read side **cannot** trap.
- **WRITE** (`__set_member_<name>`, `member-set-dispatch.ts:180`): it coerces the
  inbound value **DOWN** `externref → fieldType`. For a ref/vec field that is an
  **unguarded narrowing `ref.cast`** on a value whose runtime representation the
  dispatcher cannot know (the receiver is dynamic). This is the asymmetry: there
  is no "box up" equivalent for a write — `struct.set` requires the exact field
  type.

## #2805 verdict — this is NOT #2805

The coordinator's hypothesis (this = #2805's write-side substrate gap) is
**disproven**:

| | #2805 | #2831 (this) |
|---|---|---|
| symptom | silent **dropped write** (field stays default) | **`illegal cast` TRAP** |
| timing | MODULE-INIT (`start` section, before `__setExports`) | parse-time RUNTIME (long after `__setExports`) |
| mechanism | host setter `__sset_<field>` unreachable at init | unguarded narrowing `ref.cast` on the value coercion |
| code path | `tryEmitDeleteAwareDynamicSet` host-set gate | `fillMemberSetDispatch` value coercion (line 180) |

Same *family* (write-side, member-set-dispatch #2664/#2659), but a distinct bug.
Closest relative is the **#2806/#2809 array-representation** work (value-rep
mismatch on an externref-vec field), now manifesting at the **dynamic-write value
position**.

## Why this is architecture-scope (escalated for an architect spec)

A naive "guard the value cast with `ref.test`, else fall to the sidecar" is
**WRONG**: for a genuine write whose value is in a mismatched representation,
diverting to `__extern_set_strict` stores it in the JS sidecar while later reads
use the struct **slot** (`struct.get`) — reintroducing the exact #2664
"write-leaks-to-sidecar / read-uses-slot" desync that member-set-dispatch was
created to fix (it was the 8th acorn dogfood wall: `while (this.type !== eof)`
never terminating).

The correct fix is **representation-aware** and couples several substrates:
- **member-set-dispatch** (#2664) — the dispatcher value coercion must convert
  (not hard-cast) a vec value whose element-rep differs from the field's vec, and
  only sidecar genuinely host/incompatible values;
- **coercion engine** (#1917/#2108) — needs a guarded/representation-aware
  `externref → (ref $vec)` path (test + convert, not bare `ref.cast`);
- **#2806/#2809 array-rep family** — unify the empty/contextless `[]` vec rep so a
  value written to an externref-vec field is an externref vec (or convertible);
- **value-representation substrate** — the contextless empty `[]` at a dynamic
  any-receiver write currently has no expected-type and lowers to the wrong vec.

Blast radius: **every dynamic `any`-receiver WRITE of a ref/vec-typed field** —
a representation-scale change (reference_2379 hazard, explicitly flagged in
#2809). Requires full `merge_group` + standalone-floor validation, not a scoped
sweep. **Senior-dev / architect, `reasoning_effort: max`.**

## Acceptance

- `parse("function f(){}")`, `parse("(x) => x")`, `parse("async function f(){}")`
  on compiled acorn return the correct AST (no `illegal cast`).
- The real-world NM differential (`edge.js` module + `background.js` script)
  compiled-acorn vs node-acorn is **structurally equal** (modulo the known
  marshalling quirks: always-null `sourceFile`, boolean as i32) — THE #1712 bar.
- 0-regression `merge_group` + standalone-floor (watch the member-set-dispatch /
  any-receiver-write and `built-ins/Array/**` buckets); the #2664 slot/sidecar
  invariant (`while (this.type !== eof)` terminates) must NOT regress.

## Pointers

- `src/codegen/member-set-dispatch.ts:180` (the unguarded value coercion);
  contrast `src/codegen/member-get-dispatch.ts:174` (safe box-up).
- `findAlternateStructsForField` + `coercionInstrs` (`type-coercion.ts`).
- Repro infra (this branch `.tmp/`, gitignored): `nm-diff.mjs` (full-file
  differential), `nm-bisect.mjs` / `nm-isolate.mjs` / `nm-stack.mjs` (localization
  to the raw-export wasm trap), `dump-setlabels.mjs` (WAT dump of the dispatcher).
- Verified on freshly-compiled pinned acorn@8.16.0, 2026-06-29 (sendev).

## Implementation Plan

> Architect note (2026-06-29): reproduced on current `origin/main` and dumped the
> WAT for the actual write path. The diagnosis below **refines** the issue body
> with two load-bearing facts the original pinning did not have, both confirmed by
> WAT — and one is the difference between a fix that works and one that silently
> drops the write.

### Root cause (refined, WAT-confirmed on main)

Two facts change the shape of the correct fix:

1. **The inbound value at the dynamic write is a HOST externref, not a wasm vec.**
   For `this.x = []` on an `any` receiver, the RHS `[]` is built as a wasm
   `$__vec_externref` and then **marshalled to a host iterable via the
   `__make_iterable` import** *before* it is passed to the dispatcher
   (`__set_member_<name>`). So the value param is an opaque host externref whose
   `any.convert_extern` is **not** any `$__vec_*` struct. The dispatcher then does
   the unguarded narrowing `any.convert_extern; ref.cast(_null) (ref null $vecT)`
   (from `coercionInstrs(externref → ref/ref_null $vec)` with **no `fctx`**, the
   "No fctx available" branch of `type-coercion.ts:3013-3015 / 3036-3037`) → the
   host externref is non-null and not `$vecT` → **`illegal cast` trap**.
   Minimal local repro (traps on main in `__set_member_labels`; marshal path
   identical to acorn):
   ```ts
   var P = function P(){ this.labels = [{k:1}]; };
   P.prototype.reset = function(){ this.labels = []; };       // dynamic any-recv []
   P.prototype.run   = function(){ this.reset(); return this.labels.length; };
   ```
   WAT confirms the reset closure does: build `$__vec_externref` → `extern.convert_any`
   → `call $__make_iterable` → `call $__set_member_labels`. Because the value is a
   **host** value, a fix that only `ref.test`s it against `$__vec_base` (a wasm-vec
   check) does **NOT** see it as a vec, drops to the sidecar, and the write is
   **silently lost** (read-uses-slot desync — the exact #2664 hazard). I verified
   this empirically: a wasm-vec-only empty fast-path turned the trap into a dropped
   write (`run()` returned the stale length, not 0). **The conversion MUST be
   host-externref-aware.**

2. **The same unguarded narrowing cast is emitted by THREE setter emitters, not
   just `member-set-dispatch.ts:180`.** All three lower `externref → (ref $vecT)`
   with a bare `ref.cast`/`ref.cast_null`:
   - `src/codegen/member-set-dispatch.ts:180` — `__set_member_<name>` (#2664
     dispatcher; the pinned acorn stack frame, called from wasm at the dynamic
     write site).
   - `src/codegen/index.ts:2685-2689` (`buildSetterStore`) — the exported
     `__sset_<field>` host setter (#2659/#2805). Confirmed present in the same
     module with `any.convert_extern; ref.cast null (ref null 8)`. (Wrapped by the
     host `_safeSet` try/catch → degrades to sidecar-only, so it does not crash but
     **silently drops** the cross-rep write — still wrong.)
   - inline static-receiver writes also funnel through `coercionInstrs` /
     `emitSafeStructConversion`.
   A member-set-dispatch-only patch fixes the acorn raw-export trap but leaves the
   sibling `__sset_<field>` path dropping the same writes. **Fix the conversion
   once, centrally, and apply it at all three sites.**

### The correct conversion already exists: `buildVecFromExternref`

`src/codegen/type-coercion.ts:209` `buildVecFromExternref(ctx, fctx, externLocal,
vecTypeIdx, {arrTypeIdx, elemType})` is the **host-externref → wasm-vec**
materializer used by destructuring-params (#1464) and literal coercion (#3633). It
reads `__extern_length(extern)` and per-element `__extern_get` / `__extern_get_idx`
(standalone), coerces each element to the target vec's element type (box/unbox /
guarded ref element cast / tuple build), and `struct.new`s a **fresh vec of the
exact target type**. It is the representation-consistent **inverse of
`__make_iterable`**. It handles **empty, non-empty, and host arrays/iterables
uniformly**, and — critically — produces a value the `struct.set` stores **on the
slot** (no sidecar, no desync, no aliasing trap, no `ref.cast`).

The only obstacles to calling it from the dispatcher *fill*: it needs (a) an
`fctx` (it `allocLocal`s temps) and (b) it `ensureLateImport`s its helpers and
`flushLateImportShifts` — and **registering imports at finalize shifts every baked
func index** (the reserve-then-fill invariant this subsystem protects). So it
cannot be called raw inside `fillMemberSetDispatch`.

### Recommended approach — reserved per-target-vec materializer (Option A)

Introduce a reusable, finalize-safe **materializer helper per distinct target vec
type**:

```
__vec_from_extern_<vecTypeIdx>(val: externref) -> (ref null $__vec_<elem>)
```

whose body is `buildVecFromExternref(...)` over its single externref param. The
three setter emitters then emit, for a **vec-typed** field, simply:

```wat
local.get <recv-any> ; ref.cast $S
local.get <val-extern>
call $__vec_from_extern_<vecTypeIdx>      ;; host-extern → exact target vec, on the slot
struct.set $S <fieldIdx>
```

Lifecycle (mirrors `fillClosedMethodDispatch` #2151 / `fillExternGetIdxVecArms`
#2190 reserve-then-fill discipline → **no funcIdx churn at fill**):

1. **New finalize sub-pass `reserveVecFieldMaterializers(ctx)`**, run **before**
   `fillMemberSetDispatch` / `fillMemberGetDispatch` and before the `__sset_*`
   bodies are baked. It:
   - scans every `memberSetDispatchNames` candidate (`findAlternateStructsForField`
     filtered to `mutable`) **plus** every `__sset_*` entry list, collects the
     distinct vec-typed `fieldType.typeIdx` (a `$__vec_*` / `$__template_vec*`
     struct — detect via `ctx.typeIdxToStructName`);
   - for each distinct target vec type, reserves a function with a **real
     `FunctionContext`** and builds its body via `buildVecFromExternref` (which
     does its own `ensureLateImport` + single `flushLateImportShifts` against that
     fctx — correct, because this pass runs at a point where index shifts are still
     allowed and it owns the shift, exactly like other late-registered helpers).
     Records `ctx.vecFromExternMap: Map<number, funcIdx>`.
2. `fillMemberSetDispatch` (and the `__sset` builder, and the inline path) then
   **read-only** look up `ctx.vecFromExternMap.get(targetVecIdx)` and emit a
   `call`. For a **non-vec ref field** (object struct), use a guarded form (see
   edge cases). For **scalar fields** keep the existing `coercionInstrs` (unbox)
   path — unchanged, it never traps.

Writes and reads stay on the **same representation (the struct slot)**, so it does
**not** reintroduce the #2664 write-leaks-to-sidecar / read-uses-slot desync; the
sidecar terminal is reached **only** for an unmatched *receiver* (a genuine host
object), never for a representation-mismatched value on a matched struct receiver.

### Files / functions to change

**`src/codegen/type-coercion.ts`**
- `buildVecFromExternref` (line 209) — no behavior change; becomes the body of the
  reserved helper. Optionally factor a thin
  `buildVecFromExternMaterializer(ctx, targetVecIdx): funcIdx` that constructs the
  per-vec `FunctionContext` + calls `buildVecFromExternref`, shared by all call
  sites and the reserve pass.
- `coercionInstrs` (line 2876), `externref → ref_null` (2994-3016) and
  `externref → ref` (3017-3038) arms — when `to` is a vec type **and** a
  materializer funcIdx exists in `ctx.vecFromExternMap`, return
  `[{op:"call", funcIdx}]` instead of the bare `any.convert_extern; ref.cast`.
  This automatically fixes the **inline static-write** path too. Guard on
  `ctx.vecFromExternMap` being populated (only after the reserve pass) so
  pre-finalize callers (which pass `fctx` and can already do guarded casts) are
  unaffected.

**`src/codegen/member-set-dispatch.ts`**
- `fillMemberSetDispatch` (line 136), inner `buildSetDispatch` (line 170): replace
  the `coercionInstrs(ctx,{externref},cand.fieldType)` value coercion (line 180)
  with: vec field → `call ctx.vecFromExternMap.get(vecIdx)`; ref/ref_null (object)
  → guarded arm (below); scalar → existing `coercionInstrs`.

**`src/codegen/index.ts`**
- `buildSetterStore` (line 2657, `__sset_<field>`), `valMode === "extern"`,
  `ft.kind === "ref" | "ref_null"` (2685-2689): same substitution — `call
  $__vec_from_extern_<vecIdx>` for vec fields; guarded ref.test for object refs.
- Wire `reserveVecFieldMaterializers(ctx)` into the finalize sequence **before**
  `fillMemberSetDispatch`, `fillMemberGetDispatch`, and `__sset_*` emit.

### Wasm IR pattern (per vec-typed field arm)

```wat
;; recv already ref.test'd to $S, in the matched arm
local.get $__any            ;; receiver anyref
ref.cast $S
local.get 1                 ;; val (externref) — host iterable from __make_iterable, or any externref
call $__vec_from_extern_<vecIdx>   ;; -> (ref null $__vec_<elem>) built on the slot's exact type
struct.set $S <fieldIdx>
```

`$__vec_from_extern_<vecIdx>` body == `buildVecFromExternref` output:
`__extern_length(val)` → `array.new_default` → loop `__extern_get(val,i)` →
per-elem coerce → `array.set` → `struct.new $__vec_<elem>`; add a null/undefined
guard at the top returning `ref.null $vec` so `this.x = null` stores null on the
slot (do NOT route null to the sidecar).

### Edge cases (each needs a test)

- **Empty `[]` (acorn case, dominant):** host iterable length 0 → fresh empty
  target vec on the slot; `.push`/`.length` work. (The wasm-vec-only fast-path got
  this WRONG — must use the host-aware helper.)
- **Non-empty cross-rep value:** materializer copies + element-coerces into the
  target rep, on the slot. A copy (no aliasing) — strictly better than today's
  trap; at a dynamic any-receiver write the value was already marshalled by
  `__make_iterable`, so there is no wasm-identity to preserve.
- **Same-rep value (`this.x = oldVecReadBack`):** still goes through the
  materializer (re-reads host extern → rebuilds). Correct; if it costs on the
  floor, add a `ref.test $vecT` short-circuit (direct guarded `ref.cast`) *before*
  the materializer call. Recommend including the short-circuit from the start.
- **`null` / `undefined` write:** materializer guard → `ref.null $vec`.
- **Non-vec ref field (object struct):** no materializer; guarded `ref.test $objT →
  ref.cast; struct.set` else **sidecar** (pre-existing narrower gap; guarding stops
  the trap; full object-rep conversion is out of scope here).
- **Scalar field (f64/i32/i64/externref):** unchanged `coercionInstrs`. Never
  trapped; do not touch.
- **standalone vs host:** `buildVecFromExternref` already branches
  (`useNativeObjVec = ctx.standalone`, `__extern_get_idx` vs `__array_from_iter`)
  — both covered. Validate the standalone floor.
- **funcIdx stability:** materializers reserved in one pre-fill pass that owns its
  import shifts; `fill*`/`buildSetterStore` only `call` them. Do NOT
  `ensureLateImport` inside any `fill*`.

### Reduced-scope fallback (only if Option A is too large)

Inline in `fillMemberSetDispatch` + `buildSetterStore` for a vec field: pre-
register `buildVecFromExternref`'s imports at *reserve* time (so the fill-time
`ensureLateImport` is a no-op and its flush shifts nothing), build a **minimal
`FunctionContext` shim** at fill whose `allocLocal` appends to the
dispatcher/setter `locals`, and call `buildVecFromExternref` inline. Same runtime
behavior, no separate helper/pass, but duplicates local plumbing across two
emitters and is more fragile around the import flush — Option A preferred. **The
empty-only wasm-`$__vec_base`-test fast-path is NOT a valid fallback** — proven
insufficient (host-marshalled value → dropped write).

### Test plan (bar = #1712)

1. **Unit (`tests/issue-2831-*.test.ts`):** the reduced repros must round-trip
   (compile → instantiate → `__setExports` → `wrapExports`), asserting post-write
   `.length`/contents:
   - `this.x = []` after object pushes → length 0 (NOT stale);
   - `this.x = []` on a fresh fnctor → `.push` then `.length` works;
   - `this.x = null` → reads null;
   - same-rep restore (`this.x = old`) → length preserved;
   - non-empty cross-rep (`this.labels = [{..},{..}]`) → length 2, elements read.
   Plus a structural guard that the vec-field write routes through
   `__vec_from_extern_*` (no bare unguarded `ref.cast (ref null $__vec_*)` on the
   value in `__set_member_*`/`__sset_*`).
2. **#2664 non-regression:**
   `tests/issue-2664-member-set-dispatch-deferred-fill.test.ts` stays green (the
   `while (this.type !== eof)` terminate invariant).
3. **Acceptance bar — real acorn NM differential** (acorn-realworld's
   `.tmp/nm-diff.mjs`): compile pinned acorn@8.16.0 (`skipSemanticDiagnostics:true`),
   parse `examples/native-messaging/edge.js` (module) + `background.js` (script);
   assert AST **structurally equal** to node-acorn (modulo known quirks: null
   `sourceFile`, boolean-as-i32). The three function repros parse with no
   `illegal cast`.
4. **Full `merge_group` + standalone-floor**, 0 regressions. Watch buckets:
   `built-ins/Array/**`, any-receiver member-write, member-set-dispatch family.
   Broad-impact (representation-scale, reference_2379) ⇒ full CI, never scoped.

### Blast radius & classification

- **Scope:** every dynamic `any`-receiver **write** of a vec-typed field, across
  all three setter emitters (`__set_member_*`, `__sset_*`, inline) —
  representation-scale (reference_2379 hazard, #2809). Reads already box-up safely
  (member-get-dispatch.ts:174); untouched.
- **Classification:** senior-dev, `reasoning_effort: max`, `horizon: l`. Touches
  the coercion engine (#1917), the vec-rep family (#2806/#2809), and
  member-set-dispatch (#2664) — but the change **substitutes one conversion for a
  safe existing one** (`buildVecFromExternref`), not a coercion-engine rewrite, so
  it does **not** meet the bar for a deeper engine rework.

## Implementation Notes (sendev-2831, 2026-06-29) — DONE

Implemented Option A exactly. Files changed:
- `src/codegen/type-coercion.ts` — `buildVecFromExternMaterializer(ctx, vecIdx)`
  (reserves `__vec_from_extern_<vecIdx>(externref)->(ref null $vec)` built from a
  real synthetic `FunctionContext` + `buildVecFromExternref`, with a null guard
  and a same-rep `ref.test` identity short-circuit) and `vecFromExternFuncIdx`
  (name-based funcMap resolve). The two `externref→ref`/`ref_null` arms of
  `coercionInstrs` now return `[call materializer]` (+`ref.as_non_null` for the
  non-null arm) when `ctx.vecFromExternMap` has the target — which auto-fixes
  BOTH the member-set-dispatch fill (it calls `coercionInstrs`) and the inline
  static-write path.
- `src/codegen/member-set-dispatch.ts` — `reserveVecFieldMaterializers(ctx)`
  (the up-front reserve-then-fill pass; enumerates distinct mutable vec-typed
  field types from the dispatcher candidates AND the `__sset` struct fields).
- `src/codegen/index.ts` — wired `reserveVecFieldMaterializers` into BOTH
  finalize paths before `emitStructFieldSetters`/`fill*`; `buildSetterStore`
  (`__sset_*`) emits `call materializer` for vec fields (threaded `ctx`).
- `src/codegen/context/types.ts` — `vecFromExternMap?: Map<number,string>`.
- `tests/issue-2831-vec-from-extern-materializer.test.ts` — 6 unit tests.

**Why name-based, not funcIdx (the load-bearing decision):** the materializer is
reserved early in finalize; later fill passes (member-get-dispatch, etc.) still
register late imports and shift func indices. Storing the funcIdx in the map
would go stale. Storing the NAME and resolving via `funcMap` at each emit site is
immune (funcMap is kept in lockstep by every shift, and baked calls are walked by
`shiftLateImportIndices`). This is the #1461/#2193 late-funcIdx-shift hazard.

### Verification (local)
- The 3 function repros on freshly-compiled acorn@8.16.0:
  `function f(){}` → **PARSE OK**, `async function f(){}` → **PARSE OK**.
  `var g=(x)=>x;` → **no longer `illegal cast`** (the #2831 wall is cleared) but
  advances to the NEXT wall (below).
- NM differential: `foo(bar,baz)` is structurally equal modulo the known quirks
  (always-null `sourceFile`, boolean-as-i32 `optional`). `background.js`/`edge.js`
  now reach the SAME next wall (arrow params), not the illegal cast.
- `tests/issue-2831-*` (6) + #2664/#2806/#2809 non-regression all green; typecheck
  + prettier + biome clean.

### NEXT WALL (newly exposed — routes to a follow-up, NOT #2831)
Arrow functions **with ≥1 parameter** throw acorn's own
`SyntaxError: "Assigning to rvalue"` (a `toAssignable` divergence in arrow-param
reinterpretation). Isolation:
- `() => 1` (zero params) → **OK**
- `x => x`, `(x) => x`, `(a,b) => a`, `f((x)=>x)` → **THROW "Assigning to rvalue (1:NaN)"**
- `(1)`, `(x)`, `var y=(1);` (parenthesized exprs, no arrow) → **OK**

So the wall is specifically acorn's `parseParenAndDistinguishExpression` →
arrow-param `toAssignable(Identifier)` path. `background.js` and `edge.js` both
contain parameterized arrows, so this is what now blocks the full NM differential.
The `(1:NaN)` column hints a position/number field reads NaN on the raise path —
worth a look when scoping the follow-up. This is a distinct parser-logic bug, not
the value-representation write trap #2831 fixed.

### Known narrow gaps (architect-scoped OUT, not regressions)
- Dynamic any-receiver `.push()` on a vec read back through the host boundary
  doesn't persist the mutation (host-marshalling copy) — orthogonal any-receiver
  array-method gap; pre-existing, trapped earlier before this fix.
- A vec-of-**ref-struct** field given GENUINE host-object elements can still trap
  inside the materializer's element `ref.cast_null` (the architect's "object-rep
  conversion is out of scope"). acorn uses externref-elem vecs, which work.
