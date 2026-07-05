---
id: 3058
title: "Resizable-TA proto-methods over a dynamic `$__ta_dyn_view` receiver — runtime-kind method dispatch (materialize-into-f64-vec + OOB ValidateTypedArray + write-back)"
status: ready
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: typed-array, resizable-arraybuffer, dynamic-index
sprint: Backlog
horizon: l
es_edition: ES2024
test262_category: built-ins/TypedArray
goal: standalone-mode
related: [3054, 3057, 1781]
---

# Resizable-TA proto-methods over a dynamic `$__ta_dyn_view` receiver

## Problem

Follow-up banked from #3057 (the dynamic-view element codec, PR #2741, merged
2026-07-05). #3057 wired **element get/set** (`ta[i]` / `ta[i] = v`) on a boxed
`$__ta_dyn_view` — the runtime-kinded shared-backing view produced by a dynamic
`new <ctorVar>(rab)` where `ctorVar` is a TypedArray constructor held in an
`any`-typed variable (the `for (let ctor of ctors)` shape every resizable
test262 file uses).

What #3057 did **not** wire is **prototype-method dispatch** on that view:

```ts
for (let ctor of ctors) {          // ctor : any
  const ta = new ctor(rab, 0, 4);  // ta : any, boxed $__ta_dyn_view (runtime kind)
  ta.at(-1);                        // RUNTIME "illegal cast" today
  ta.indexOf(3);                    // runs but returns -1 (scans the wrong backing)
  ta.slice();                       // wrong / traps
  ta.length;                        // ✅ already correct (accessor path)
  ta[2];                            // ✅ #3057 element codec
}
```

## Measure-first (senior-dev, opus, 2026-07-05 — against main @ 59d7b6fd5, i.e. POST-#3057)

Ran the standalone lane (`runTest262File(..., "standalone")`) over the 25
`built-ins/TypedArray/prototype/*/resizable-buffer.js` files plus the `with/`
and `sort/` resizable variants. Result on the post-#3057 base:

- **26 `fail`**, **1 `compile_error`** (`entries/resizable-buffer.js`),
  **1 `pass`** (`with/valid-typedarray-index-checked-after-coercions.js`).

Direct minimal-snippet probes (dynamic `new ctor(rab,0,4)` + method) pinned the
**mechanism** precisely:

| probe             | result             | meaning                                                            |
| ----------------- | ------------------ | ------------------------------------------------------------------ |
| `ta[2]` (element) | ✅ correct (#3057) | element codec works                                                |
| `ta.length`       | ✅ correct         | accessor path already handles the view                             |
| `ta.at(-1)`       | ❌ **illegal cast**| reaches a native method impl that `ref.cast`s to a concrete view   |
| `ta.indexOf(3)`   | ❌ returns `-1`    | runs over an empty/opaque backing (wrong vec)                      |
| `ta.slice()`      | ❌ wrong/throws    | species-producing; no dyn-view arm                                 |

### Root cause

The native array/TA method dispatch (`compileArrayMethodCall`,
`src/codegen/array-methods.ts`) resolves the receiver to a concrete WasmGC vec
type. For a **static** per-kind `$__ta_view` it has a materialization arm
(#3054 B1, array-methods.ts:~2997 `isTaViewTypeIdx`) that copies the view into a
native element-typed vec via `emitTaViewToVec` and rebinds the identifier, so the
ordinary method impl then runs. For a **dynamic** `$__ta_dyn_view` the receiver
is a boxed **externref** (`receiverIsExternref = true`) whose element kind is a
**runtime** `kind` field, so:

1. it never enters the `ref`/`ref_null` materialization branch, and
2. `emitTaViewToVec`'s template needs a **compile-time** kind descriptor
   (`taViewDecode`) — which the dyn view does not have.

So the method either `ref.cast`-traps (`.at`) or scans a default/empty vec
(`.indexOf` → -1).

### The "cheap proto-method" framing is PARTLY DISPROVEN

The dispatching task hypothesised a bucket of **cheap** read-only proto-methods
that flip enforced-assert tests with bounded effort. Measure-first shows this is
**not** how the test files are shaped: every `*/resizable-buffer.js` file
**interleaves `rab.resize(...)` with `assert.throws(TypeError, () => ta.<m>())`**
(the ValidateTypedArray out-of-bounds semantics — §23.2.3 methods begin with
ValidateTypedArray, which throws TypeError when the fixed-length view no longer
fits the shrunk buffer). So flipping a **whole** file to `pass` requires, per
method:

1. happy-path element read via the #3057 codec (the "cheap" part), **plus**
2. **ValidateTypedArray OOB → throw TypeError** (fixed-length view no longer
   fits after shrink), **plus**
3. **length-tracking effective length** after grow/shrink (auto-length views).

There is **no single cheap method** that flips a full enforced-assert file on
its own — the OOB-throw + effective-length machinery is a **shared prerequisite**
for all of them. That machinery is the real cost; once built, each method is a
thin arm. This makes the work an **L-sized shared-scaffolding** task, not a
budget-window slice — hence banked here rather than force-shipped at ~18% budget.

## Recommended design (de-risked by the measure-first)

**Build the shared scaffolding once, then add thin per-method arms.**

### 1. `emitTaDynViewToVec` — runtime-kind materialization into an f64 vec

Mirror `emitTaViewToVec` (`src/codegen/dataview-native.ts:2515`), but:

- The dyn view's kind is a **runtime** `kind` field, so the native vec's element
  type cannot be chosen at compile time. **Materialize into a single
  `__vec_f64`** (widen every kind to f64) — this makes the numeric read-side
  methods (`at`, `indexOf`, `lastIndexOf`, `includes`, `join`, `find*`, `every`,
  `some`, `forEach`, `reduce*`, `sort`, `toLocaleString`, `map`, `filter`) work
  through the **existing** f64-vec method impls for free.
- Decode each element by **runtime kind** using the #3057 codec engine — the
  nested `if`-chain over `TA_CTOR_KINDS` in `emitTaDynViewElementGet` is the
  exact pattern to reuse (extract a shared `emitDynDecodeAt(off, kind) -> f64`).
- Length = `pushTaDynViewEffectiveLen` (resolves the -1 auto-length sentinel to
  the live count; already exists).

### 2. `emitTaDynViewValidate` — ValidateTypedArray OOB → throw TypeError

A fixed-length dyn view (length field ≥ 0) is OOB when
`byteOffset + length*elemSize(kind) > buf.byteLength`. Emit that check and, on
OOB, `emitThrowTypeError` (the native throw helper already used across
`property-access.ts` / `type-coercion.ts` in the standalone lane). Auto-length
views (length field = -1) are never OOB by shrink (they track) — only OOB when
`byteOffset > buf.byteLength`. Call this at the **top** of every dyn-view method
arm (matches §23.2.3.* step 1 ValidateTypedArray).

### 3. Wire at the dispatch site (array-methods.ts:~2985)

Right where `receiverIsExternref` is computed, add: if `ctx.moduleUsesDynTaView`
and the probe-compiled receiver `ref.test $__ta_dyn_view`, then
`emitTaDynViewValidate` + `emitTaDynViewToVec` → f64 vec, rebind the identifier
(exactly like the B1 `$__ta_view` rebind at 2997), and let the ordinary f64-vec
method impl run.

### 4. Write-back for mutators (fill/copyWithin/sort/reverse/set)

Mirror #3054 B3 `emitTaViewWriteBack` — after the mutating method runs on the
f64-vec copy, byte-**encode** each element back through the codec
(`emitTaDynViewElementSet`'s per-kind encoder, incl. the Uint8Clamped clamp) into
the view's shared buffer. Capture the same (view local, effective len) so
copy-len == write-back-len.

### 5. Bucket split (per-method landing order)

- **Bucket A — read-side, no new value produced** (thin arms once 1–3 land):
  `at`, `indexOf`, `lastIndexOf`, `includes`, `join`, `find`, `findIndex`,
  `findLast`, `findLastIndex`, `every`, `some`, `forEach`, `reduce`,
  `reduceRight`, `toLocaleString`. Est. flips: ~15 files.
- **Bucket B — in-place mutators** (needs step 4 write-back): `fill`,
  `copyWithin`, `reverse`, `sort`. Est. flips: ~4 files.
- **Bucket C — species / new-view producers** (HARDER — the result must be a
  real TA with a `.buffer`, so materialize-into-f64-vec is insufficient; needs a
  species-constructed `$__ta_view`/`$__ta_dyn_view` result): `slice`, `subarray`,
  `map`, `filter`, `with`, `toSorted`, `toReversed`. **Bank C as its own
  follow-up** if it proves large — the test asserts (`result.buffer.resizable`,
  `!result.buffer.resizable`) require real buffer identity on the result.
- **Iterators** (`keys`, `values`, `entries` — the 1 CE): return iterator
  objects; separate small follow-up.

## Hazard (carry-over from #3057)

The dispatch site is **shared** with plain-array and static-TA-view `any`
receivers. **`ref.test $__ta_dyn_view` FIRST**; on a miss fall through to the
EXACT existing behavior. Gate all new emit behind `ctx.moduleUsesDynTaView`
(the #3057 module pre-scan) so a module without a dynamic TA construct is
**byte-inert** (verify sha256 of a non-dyn-view program unchanged). Reuse the
#3057 element codec (`emitTaDynViewElementGet/Set`, `pushElemSizeForKind`,
`pushTaDynViewEffectiveLen`, `pushTaDynViewInBoundsLen`) — do not duplicate it.

## Acceptance criteria

- `emitTaDynViewToVec` + `emitTaDynViewValidate` land with host-enforced unit
  tests (a dynamic `new ctor(rab,...)` view → `.at`/`.indexOf`/`.join` returns
  correct values; OOB after `rab.resize` throws `TypeError`; length-tracking
  after grow reads the new length).
- Bucket A methods flip their `*/resizable-buffer.js` files to `pass` on the
  standalone lane (these have ENFORCED structural asserts — `compareArray` /
  `ToNumbers` / `sameValue` — so the flip is **floor-VISIBLE**, not vacuous).
- A plain-array / static-view `any` receiver is **unchanged** (byte-inert
  regression guard, and a mixed-module sha256 check).
- Standalone floor does not regress; report the measured pass-count delta.

## Estimated impact

~15 Bucket-A files + ~4 Bucket-B files are floor-VISIBLE flips (enforced asserts).
Bucket C (~7 files) + iterators (1 CE) banked as harder follow-ups.

## References

- #3057 (PR #2741, merged) — dynamic-view element codec + `moduleUsesDynTaView`
  pre-scan + `emitTaDynViewElementGet/Set` + `pushTaDynViewEffectiveLen`.
- #3054 (D+E / B1 / B3) — `$__ta_dyn_view` construct, `emitTaViewToVec`,
  `emitTaViewWriteBack`, the `isTaViewTypeIdx` rebind arm (the exact templates).
- #1781 — resizable ArrayBuffer umbrella.
- `src/codegen/array-methods.ts:~2985-3026` — the dispatch/rebind site.
- `src/codegen/dataview-native.ts:2515` (`emitTaViewToVec`), `:2654`
  (`emitTaViewWriteBack`), `:1551`/`:1684` (element codec) — reuse.
