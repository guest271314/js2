---
id: 2916
title: "[SUBSTRATE][ARCH] Standalone native instanceof operator + isPrototypeOf residual (~31 leaky-PASS conversions)"
status: in-progress
assignee: ttraenkler/sendev-instanceof
sprint: current
created: 2026-07-01
priority: medium
horizon: l
feasibility: hard
model: fable
reasoning_effort: high
task_type: feature
area: codegen
language_feature: instanceof
goal: standalone
related: [2702, 2740, 2605, 1325, 1536c, 2188, 2907, 799]
origin: "2026-07-01 — sr-tail2 escalation: leaky-PASS conversion cluster, substrate REPLACEMENT (native OrdinaryHasInstance), not a leaf swap"
---

# #2916 — Standalone native `instanceof` operator + `isPrototypeOf` residual

## Problem (verified on `main` `f350ba855`, 2026-07-01)

Under `--target standalone` the dynamic `instanceof` operator leaks an
unsatisfiable `env::__instanceof*` host import, so the module cannot instantiate
host-free and fails the standalone floor. This is a **leaky-PASS cluster**: the
test passes in JS-host mode (the host provides `__instanceof`), but standalone
emits the import and dies at instantiation.

Confirmed by probe (`--target standalone`, `.tmp/probe_name.ts` / `probe_inst.ts`):

| Source shape | Leaked host import |
|---|---|
| `a instanceof Array` (any LHS, builtin-name RHS) | `env::__instanceof` |
| `a instanceof C` (any LHS, `any`-typed RHS identifier) | `env::__instanceof_check` |
| `a instanceof C` where RHS resolves to no class/struct name | `env::__instanceof_dyn` |

Because the host import is **entirely absent** in standalone, making `instanceof`
native does not swap one leaf — it **REPLACES §13.10.2 InstanceofOperator /
§7.3.20 OrdinaryHasInstance for the entire dynamic surface**. The native
tri-state must reproduce enough of the host `_instanceofResult`
(`src/runtime.ts:2322`) to not regress the full leaky-PASS surface (well beyond
the ~12 sampled / ~31 estimated).

Spec'd **together with the `isPrototypeOf` residual** because they share one
proto-chain-walk substrate.

## Background — three entry points, one already-native model

The `instanceof` binary op is intercepted in `expressions.ts:1137`:

- `resolveInstanceOfRHS` unresolved → `compileHostInstanceOf`
  (`identifiers.ts:1297`).
  - simple builtin/user-name RHS → string-name path, leaks `__instanceof`
    (`identifiers.ts:1465`).
  - non-identifier / dynamic RHS → `emitDynamicInstanceOf`
    (`identifiers.ts:1247`), leaks `__instanceof_check` (`identifiers.ts:1252`).
- resolvable RHS → `compileBinaryExpression` → `binary-ops.ts:364` →
  `compileInstanceOf` (`typeof-delete.ts:782`); unresolved `className` leaks
  `__instanceof_dyn` (`typeof-delete.ts:790`).

**The model to generalize already exists.** `compileHostInstanceOf` has a
`noJsHost(ctx)` **native inline branch** for the Error family
(`identifiers.ts:1394–1462`): it `ref.test`s the value against `$Error_struct`,
reads a discriminating field (builtin `$tag` fieldIdx 0, or per-class brand
fieldIdx 4 — #2188), and emits `i32.const 0/1` with **zero host imports**.
`#2605` did the same for native collections in `compileInstanceOf`
(`typeof-delete.ts`, `ref.test $Map`). `#1325` supplies the negative-tag
registry (`builtin-tags.ts`). This issue extends that native inline model from
{Error-family, Set/Map} to **all builtins reached dynamically**, plus a native
`__instanceof_check` / `__instanceof_dyn` for the fully-dynamic RHS.

`isPrototypeOf` is **already native** host-free: `__isPrototypeOf`
(`object-runtime.ts:2758`, in `OBJECT_RUNTIME_HELPER_NAMES`
`object-runtime.ts:8447`) walks `$Object.$proto` (fieldIdx 0) with `ref.eq` per
level. It is wired for the common method-call / borrowed-call forms
(`calls-closures.ts:418`, `calls.ts:4887`). The **residual** is the diffuse
generic host-method fallback (e.g. `Function.prototype.isPrototypeOf` reached
through the generic extern-method resolver, entangled with `Function.prototype`
/ `bind` value-rep) — that path does not reach the wired native helper and still
leaks. It shares the `$Object.$proto` walk with the instanceof substrate.

## Implementation Plan

### Root cause
`ensureLateImport` (`late-imports.ts:382`) has native routing for
`UNION_NATIVE_HELPER_NAMES` / `OBJECT_RUNTIME_HELPER_NAMES` (line 438) but
**none for `__instanceof*`**, so those names fall through to
`addImport(ctx, "env", name)` (line 470) — a host import that is unsatisfiable
standalone. The dynamic `instanceof` codegen has a native inline branch only for
the Error family; every other builtin / dynamic RHS reaches the host path.

### The crux sr-tail2 flagged — `target.prototype` off a constructor externref

A fully-reflective `OrdinaryHasInstance` needs `Get(C, "prototype")`. Standalone
has **no `.prototype` on the constructor carrier**: `#2907`'s well-known-global
carriers are empty `$Object` singletons (its own follow-up notes
"`.name`/`.prototype` on the Error-family carriers … returns `undefined`"). And
user-class instances are heterogeneous WasmGC structs with **no uniform proto
slot** (only the `$Object` open-object struct and native-collection instances
carry `$proto` at fieldIdx 0).

**Mitigation — specialize on the compile-time-known RHS instead of a runtime
`.prototype` read.** In the string-name path the RHS ctor name is a **codegen
constant** (`ctorName` at `identifiers.ts:1338`). So do NOT emit a generic
runtime `__instanceof(value, ctorName)` — emit an **inline native membership
test specialized to the known `ctorName`**, exactly as the Error-family branch
already does. This sidesteps `.prototype` entirely for the dominant leak
(`__instanceof`), is tractable, and is byte-inert for gc/host (gated
`noJsHost(ctx)`). A reflective `.prototype` read is only needed for the residual
fully-dynamic `__instanceof_check` (RHS an arbitrary runtime value) — scope that
as the harder, smaller slice (below).

### Slice A — generalize the native inline string-name branch (bulk of ~31)

**File: `src/codegen/expressions/identifiers.ts`**
- In `compileHostInstanceOf`, BEFORE the `__instanceof` late-import
  (line 1465), extend the existing `noJsHost(ctx)` native branch (currently
  gated on Error-family only at line 1394) to a general
  `emitNativeBuiltinInstanceOf(ctx, fctx, expr, ctorName)` that dispatches on
  the known `ctorName`:
  - `Object` → universal-object membership: the value `ref.test`s as ANY GC
    struct that is a real object (object literal / class instance / `$Object` /
    `$Vec` / closure / `$Error_struct` / native collection). Reuse the
    `tryStaticInstanceOf` §1729 rule (`identifiers.ts:1164`) but at runtime for
    an `any` value: emit `ref.test` against the object supertype (`anyref` that
    is not i31/primitive). Primitives (i31, boxed number/bool) → 0.
  - `Function` → native closure membership: `ref.test` against closure struct
    types (`ctx.closureInfoByTypeIdx` keys), mirroring the host `__is_closure`
    arm (`runtime.ts:2427`). This is the #1992 case (currently hardcoded false).
  - `Array` → `ref.test ctx.vecBaseTypeIdx` (the `$__vec_base` supertype,
    `registry/types.ts`), so every `$Vec` element-typed subtype matches.
  - `Error` / `*Error` → keep the existing field-0 tag / field-4 brand check
    (lines 1394–1462); refactor into the shared helper.
  - `Map`/`Set`/`WeakMap`/`WeakSet` → `ref.test ctx.mapTypeIdx` (per #2605;
    carry forward its documented cross-type-imprecision caveat).
  - `Date` / `RegExp` / `Promise` / `ArrayBuffer` / `DataView` → `ref.test`
    against their backing struct type idx (see `ctx.dvWindowTypeIdx` etc.; add
    accessors where missing). Where a native backing struct does not yet exist
    (TypedArray views share `$Vec` with plain arrays — the #2893 brand gap),
    **defer to #2893/#2872's brand** rather than emit a false positive; return a
    conservative refusal-or-0 with a `#2916` cite, never a wrong `true`.
  - Unknown / unsupported builtin RHS → keep the current behavior guarded so it
    only refuses/zeroes under `noJsHost`, never regressing gc/host.
- Every arm normalizes the LHS: `any.convert_extern` (if externref) → store
  anyref local → `ref.test` (never traps on null/primitive) → `if` → tag/field
  compare. This is the exact shape of the Error branch — factor it into one
  helper taking `(structTypeIdx, discriminator?)`.

### Slice B — native `__instanceof_check` / `__instanceof_dyn` (fully-dynamic RHS)

**Files: `src/codegen/expressions/identifiers.ts` (`emitDynamicInstanceOf`,
line 1247), `src/codegen/typeof-delete.ts` (`compileInstanceOf` dyn arm,
line 790), plus a new `ensureInstanceofRuntime(ctx)` (co-locate with
`ensureObjectRuntime` in `object-runtime.ts`).**
- Emit native WasmGC `__instanceof_check(anyLHS, anyRHS) -> i32` and
  `__instanceof_dyn` (same body) as **DEFINED** functions (no import → no index
  shift, same invariant as the object-runtime helpers). Register their names in
  a native-helper set consulted by `ensureLateImport`
  (`late-imports.ts` — mirror the `OBJECT_RUNTIME_HELPER_NAMES` routing at
  line 438 so the existing call sites resolve to the native funcIdx unchanged).
- Native tri-state body (0/1/2), reproducing the tractable subset of
  `_instanceofResult`:
  1. RHS classification: if RHS is a **native constructor carrier / class
     object** whose identity maps to a known builtin tag or user-class id via a
     runtime brand (`$ClassMeta` / the #2188 brand, or the #2907 carrier once it
     carries a ctor-id), dispatch to the Slice-A membership walk keyed on that
     tag. If RHS is a **closure** (IsCallable via `ref.test` closure struct) but
     carries no resolvable `.prototype`/brand, conservatively return `0` (matches
     the host dynamic-path §7.3.20-step-3 conservative `false`, `runtime.ts:2385`
     — NOT a throw, to preserve `primitive instanceof Function(...)` → false).
  2. RHS is a **non-callable object** with an OWN `@@hasInstance` opt-in → `2`
     (throw). Custom `@@hasInstance` DISPATCH is out of scope for the first cut
     (standalone values rarely carry it); document the gap and return the
     conservative branch, never a wrong `true`.
  3. RHS is a genuine **primitive / null / undefined**: dynamic path returns `0`
     (mirror `runtime.ts:2352`), NOT `2` — the statically-primitive-RHS throw is
     already handled at codegen (`identifiers.ts:1310–1334`).
- `emitInstanceofThrowGuard` (`identifiers.ts:1224`) already turns the `2`
  sentinel into a wasm-thrown `TypeError` — reuse it unchanged.

### Slice C (same substrate) — `isPrototypeOf` generic-host-method residual

**Files: `src/codegen/expressions/calls.ts` (~4830 generic extern-method arm),
`src/codegen/expressions/calls-closures.ts:418`.**
- Route the generic host-method fallback for `isPrototypeOf` (the
  `Function.prototype.isPrototypeOf` / borrowed-generic form that currently
  bypasses the wired native helper) to the **existing native `__isPrototypeOf`**
  (`object-runtime.ts:2758`) instead of a host import. Confirm the receiver is
  normalized to `$Object`-anyref before the proto-walk; where the receiver is a
  non-`$Object` struct with no `$proto` field, the walk correctly returns 0
  (matches host for a value not in the chain).
- The proto-walk over `$Object.$proto` fieldIdx 0 is the **shared substrate**
  with Slice B's user-class membership — extract it into one internal
  `emitProtoChainWalk(targetLocal, curLocal)` helper reused by both.

### Wasm IR pattern (Slice A — `a instanceof Function`, native)
```wasm
local.get $a
any.convert_extern            ;; externref -> anyref
local.tee $any
ref.test $__closure_base      ;; ctx.closureInfoByTypeIdx supertype
;; leaves i32 0/1 (no host import, no throw for a callable RHS name)
```

### Edge cases
- LHS null / undefined / primitive (i31, boxed number/bool) → every arm 0
  (ref.test on a non-matching type is 0, never traps).
- `x instanceof Object` for a `$Vec` / closure / `$Error_struct` → 1 (§1729
  universal-object rule; these are all real objects).
- `x instanceof Function` for a WasmGC closure → 1 (#1992 fix; currently false).
- Cross-type collection assertion (`set instanceof Map`) — carry the #2605
  documented `$Map`-shared imprecision; do not silently regress.
- TypedArray views (`u8 instanceof Uint8Array`) — brand-gated (#2893/#2872);
  defer, never emit a false positive against `$Vec`.
- Statically-primitive RHS (`x instanceof 1`) — unchanged, throws at codegen
  (`identifiers.ts:1310`).
- gc/host mode: every new arm gated `noJsHost(ctx)` / the native-helper set —
  gc/host must be **byte-identical** (assert with a small compile-diff probe,
  per #2907's methodology).

### Regression-risk mitigation
- **Byte-inert for gc/host**: all changes behind `noJsHost(ctx)` /
  `ctx.standalone || ctx.wasi` gates; the host `__instanceof*` path is untouched
  when a JS host is present.
- **The static path already resolves the common cases** (`tryStaticInstanceOf`,
  `identifiers.ts:1105`) — native codegen only affects the DYNAMIC residual, so
  the blast radius is the any-LHS / dynamic-RHS subset.
- **Never emit a wrong `true`**: where a builtin's native backing struct is
  ambiguous (TypedArray/`$Vec`) or the RHS identity is unresolvable, return the
  conservative `0` / `2`, never a false positive — a false `true` is a
  correctness regression, a false `false` is only a missed conversion.
- **Full `merge_group` validation required** (substrate replacement, broad
  impact — per `project_broad_impact_validate_full_ci`): do NOT gate on a scoped
  sweep. Watch the standalone floor and the `built-ins/*` + `language/*`
  merge-shard reports.

### Corpus-verify plan
- Leak-probe (per #2907 methodology) over `test/language/expressions/instanceof/`
  (~43 files, local sweep was 28 pass / 15 fail #2740) + the `built-ins`
  `isPrototypeOf` / `Function/prototype` families, `--target standalone`, count
  `env::__instanceof*` / host-method leaks → 0.
- Confirm `net_per_test > 0`, ratio < 10%, no bucket > 50 on the standalone
  shard before enqueue.
- Regression control: verify `x instanceof Error/TypeError` (already native,
  #1536c/#2188) and native-collection instanceof (#2605) stay green.

### Split recommendation
**Split into two dev slices, spec'd together (shared proto-walk substrate):**
- **Slice A** (medium, byte-inert): generalize the native inline string-name
  branch — captures the dominant `__instanceof` leak (bulk of ~31). Land first.
- **Slice B + C** (large, harder): native `__instanceof_check` /
  `__instanceof_dyn` fully-dynamic tri-state + the `isPrototypeOf` generic
  residual, sharing `emitProtoChainWalk`. Depends on Slice A landing.

## Acceptance
- Standalone dynamic `instanceof` emits **zero** `env::__instanceof*` imports
  and instantiates host-free.
- The `isPrototypeOf` generic-host-method residual no longer leaks.
- `net_per_test > 0` on the standalone floor; no wrong-`true` correctness
  regression in the `instanceof` / `isPrototypeOf` corpus.
- gc/host byte-identical (compile-diff probe).
- Full `merge_group` net-positive.

## Implementation Notes — Slice A landed (sendev-instanceof, 2026-07-01)

**Scope delivered: Slice A only. Slice B + C deferred (escalated to lead — NOT
churned).**

### Why this split (root-cause + measure-first)
Confirmed by broad standalone sweep (196 instanceof-using tests): the leak is
dominated by `env::__instanceof` on the *string-name* path (~30 files), with a
smaller `__instanceof_check` fully-dynamic-RHS tail (~7). Crucially, the 12
leaky-PASSES *inside* the `instanceof`/`isPrototypeOf` test directories are ALL
the hard cases — `symbol-hasinstance-*` (@@hasInstance dispatch, spec-declared
out-of-scope), `primitive-prototype`/`prototype-getter` (the reflective
`Get(C,"prototype")` crux sr-tail2 flagged), and non-callable-RHS `TypeError`
throws. Slice A converts NONE of those; they need Slice B's reflective
`.prototype` path, which is only tractable once the ctor-carrier grows a real
`.prototype`/brand (#2907 follow-up). Attempting a partial `__instanceof_check`
here is the "partial/wrong instanceof" graveyard, so it was deliberately left to
a follow-up rather than churned.

### What Slice A does (`src/codegen/expressions/identifiers.ts`)
On the `noJsHost` string-name path in `compileHostInstanceOf`, BEFORE the
`__instanceof` late-import, dispatch on the compile-time-known `ctorName` to an
inline native `ref.test` membership test
(`nativeBuiltinInstanceOfTypeIdxs` + `emitNativeInstanceOfMembership`):
`Array`→vec subtypes (`vecBaseTypeIdx` ∪ `vecTypeMap`), `Function`→closure root
structs (#1992), `Map`/`Set`/`WeakMap`/`WeakSet`→`mapTypeIdx` (#2605 shared-$Map
imprecision carried), `Number`/`String`/`Boolean`→wrapper structs. Error-family
keeps its existing native branch untouched. Any builtin not modeled here
(`Object`, `Date`, `RegExp`, `Promise`, `ArrayBuffer`, …) or an unresolvable
non-builtin ctor falls to a conservative `0` — a *missed conversion*, never a
wrong `true`. The host `__instanceof` import is NEVER emitted under `noJsHost`.

### Why this is regression-safe (the airtight part)
1. The `noJsHost` string-name branch *currently always leaks* `__instanceof` →
   the module cannot instantiate standalone → **every reaching test already
   fails**. A native answer can only CONVERT a failing test, never regress a
   passing one (a standalone-passing test cannot contain a leaking instanceof).
2. gc/host is **byte-identical**: the branch is gated `noJsHost(ctx)`; verified
   with a 6-program binary-SHA compile-diff (branch == baseline, all match).
3. `ref.test` uses *type* indices, which are rec-group / dead-elim stable — no
   funcidx-ordering hazard (cf. `dyn-read.ts:287`). No late-import shift added.

### Measured
Synthetic corpus: `__instanceof` leaks 21→2 (the 2 residual are Slice-B
`__instanceof_check`). Runtime correctness verified standalone: `[]`/Map/Set/
WeakMap → true, closure → true (#1992), primitive/null/non-matching → false,
Error-family preserved. Real-corpus dynamic-LHS conversion confirmed
(`RegExp.prototype.exec(...) instanceof Array`, an `any`-typed result, flips
sa-fail→sa-pass; baseline fails). Note: many statically-typed `instanceof Array`
sites were already resolved by `tryStaticInstanceOf`, so the *net* Slice-A yield
is the dynamic-LHS residual; the `new Number()`-wrapper cases do NOT convert
because `new Number(x): any` collapses to a boxed primitive (a separate
representation gap, #1111/#2503), not `$WrapperNumber` — kept in the set but
harmless (never a wrong `true`). Authoritative conversion count = `merge_group`
`net_per_test`.

### Deferred to follow-up (NOT in this PR)
- **Slice B**: native `__instanceof_check`/`__instanceof_dyn` fully-dynamic
  tri-state (reflective `.prototype`, non-callable-RHS throw). Needs the
  ctor-carrier `.prototype`/brand infra (#2907 follow-up) first.
- **Slice C**: `isPrototypeOf` generic-host-method residual (1 leaky-PASS in the
  corpus) — shares Slice B's proto-walk substrate; deferred with B.
- **Slice A tails**: `Object` (needs a struct-minus-boxed discriminator to avoid
  a wrong `true` on boxed primitives), `Date`/`RegExp`/`Promise`/`ArrayBuffer`
  membership (readable backing-struct idxs not yet wired), TypedArray brand
  (#2893/#2872).


## Reconciliation note (shepherd, 2026-07-01)

Landed slice: **Slice A** standalone native `instanceof` builtin membership (PR #2418). Issue stays `in-progress` for the remaining instanceof/isPrototypeOf slices.
