---
id: 3057
title: "Dynamic `$__ta_dyn_view` element get/set — runtime-kind byte codec on the generic dynamic index path"
status: done
assignee: opus-3057
completed: 2026-07-05
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: typed-array, resizable-arraybuffer, dynamic-index
sprint: Backlog
es_edition: ES2024
test262_category: built-ins/TypedArray, built-ins/ArrayBuffer
goal: standalone-mode
related: [3054, 3055, 1781]
---

# Dynamic `$__ta_dyn_view` element get/set — runtime-kind byte codec on the generic dynamic index path

## Problem

Follow-up banked from #3054 D+E (PR #2740). D+E landed dynamic
`new <ctorVar>(rab)` construction: a boxed `$__ta_dyn_view` view produced by
`new <ctorVar>(rab)` where `ctorVar` is a TypedArray constructor held in a
variable (typed `any`). The view is a real shared-backing window over the
(possibly resizable) buffer, and `.length` / `.byteLength` / proto-method
write-through all dispatch correctly on the view's **runtime** TA kind (stored
in the struct field `kind`).

What D+E did **not** wire up is **element access by index** on such a view when
the receiver is statically `any`:

```ts
const ta = new ctorVar(rab); // ta : any, boxed $__ta_dyn_view, kind known only at runtime
const x = ta[i];             // generic dynamic INDEX get — no runtime-kind codec arm
ta[i] = v;                   // generic dynamic INDEX set — no runtime-kind codec arm
```

### Root cause

The `$__ta_dyn_view` struct carries its TypedArray kind (Int8 / Uint8 /
Uint8Clamped / Int16 / ... / Float64) **only at runtime**, in the `kind` field.
The generic dynamic index dispatch (`ta[i]` / `ta[i] = v` for an `any`
receiver) has **no arm that switches on that runtime `kind` byte** to decode /
encode the element. As a result:

- **155 of the 188** resizable-buffer test262 tests now **RUN host-free** (a D+E
  win — they used to bail earlier) but **fail element-value asserts**: the
  dynamic index path reads the wrong bytes / wrong element width because it does
  not know the element size or signedness at that site.
- **13** of them hit an **invalid `array.get`** against the new
  `$__ta_dyn_view` struct (the generic path assumes a plain WasmGC array
  backing) -> **CE**.

This is **non-pass -> non-pass**, confined to the resizable-buffer shim tests --
**no standalone floor regression** (verified in #2740: the +17 floor gain is
independent of these still-failing element asserts).

## Fix direction

Add a **runtime-kind byte-codec arm** to the generic dynamic index dispatch
(both get and set) that, when the receiver is a `$__ta_dyn_view`:

1. Reads the runtime `kind` byte from the view struct.
2. Computes the element address as `byteOffset + i * elemSize(kind)` (the view
   already stores `byteOffset` and its shared-backing buffer handle).
3. Byte-decodes (get) / byte-encodes (set) the element through the existing
   **dataview-native little-endian engine** (`src/codegen/dataview-native.ts`,
   the same LE codec D+E's proto-method write-through already uses), switching
   on `kind` for width + signedness + float-vs-int (and the Uint8Clamped clamp
   on set).

This reuses the LE codec that B3 write-through and D+E already rely on, so the
element path becomes consistent with the proto-method path.

## Hazard (flagged by opus-3054-de)

The generic dynamic index path is **shared** with boxed **plain-array**
receivers -- e.g. a plain `values[i]` where `values` is also statically `any`.
The new codec arm **MUST NOT hijack** those: a plain-array `any[i]` must keep
its current array-backed behavior. **Gate the new arm on
`ref.test $__ta_dyn_view` first** (structural runtime type test on the receiver)
and only enter the byte-codec when the test passes; fall through to the existing
array path otherwise. Do not switch on anything but the concrete
`$__ta_dyn_view` ref type -- a looser gate (e.g. "has a `kind` field") risks
false positives on other boxed shapes.

## Acceptance criteria

- `ta[i]` (get) on a boxed `$__ta_dyn_view` returns the correct element value
  for every TA kind (Int8/Uint8/Uint8Clamped/Int16/Uint16/Int32/Uint32/
  Float32/Float64), reading `byteOffset + i*elemSize` via the LE engine.
- `ta[i] = v` (set) writes the correct little-endian bytes for every kind
  (including the Uint8Clamped clamp), observable through a sibling view / the
  backing buffer.
- The 13 previously-CE tests no longer hit invalid `array.get` (no CE).
- A plain-array `any` receiver `values[i]` get/set is **unchanged** (regression
  guard test: mixed function that indexes both a `$__ta_dyn_view` and a plain
  boxed array through `any`).
- Standalone floor does not regress; a large share of the 155 element-assert
  failures flip to pass.

## Estimated impact

Should flip a large share of the **155** now-running-but-failing resizable tests
and remove the **13** CE. Completes the element-access half of the dynamic-view
story #3054 D+E opened.

## References

- #3054 (D+E, PR #2740) -- dynamic `new <ctorVar>(rab)`, `$__ta_dyn_view`,
  `.length`/`.byteLength`/write-through dispatch on runtime `kind`.
- #3055 -- sibling resizable-buffer follow-up.
- #1781 -- resizable ArrayBuffer umbrella.
- `src/codegen/dataview-native.ts` -- the LE byte codec to reuse.
- `src/codegen/property-access.ts` -- the generic dynamic index dispatch site
  where the new `ref.test $__ta_dyn_view` codec arm lands.

## Implementation notes (opus-3057)

### Measure-first: the trap hypothesis was DISPROVEN

The issue framing (from #2740) hypothesised element access might TRAP or CE,
which would make fixing the codec a large trap→run floor win. Direct standalone
probes on current main proved otherwise: **element access does NOT trap and does
NOT CE — it RUNS and returns `0`** (writes silently no-op'd through `__extern_set`
on the opaque struct; reads returned `0` through `__extern_get_idx`). Confirmed
for Int32/Uint8/Float64 round-trips + sibling-view aliasing (all returned 0).

Running the actual resizable element-access test262 files through the standalone
lane (`runTest262File(..., "standalone")`) classified the failures as a MIX:
some numeric-only element tests (`out-of-bounds-get-and-set.js`) already pass
**vacuously** (return 0, unenforced numeric asserts — #3055/#3056); the failing
ones fail on **enforced structural asserts** that read elements via
`ToNumbers`/`Collect`/`compareArray` through an `any` receiver (sort / copyWithin
/ reduce / forEach `assert.compareArray(ToNumbers(taFull), [...])`). The CE/trap
buckets in that sample are unrelated proto/species gaps (`.from`, `.entries`,
`.slice`, speciesctor), **not** the raw index codec. So the payoff is the
smaller correctness-flip case (enforced structural element asserts) plus
**de-vacuifying** the already-passing numeric tests — NOT a ~155 trap→run flip.
The fix is correct and needed regardless of the exact floor count.

### Design

Two new functions in `dataview-native.ts` — `emitTaDynViewElementGet` /
`emitTaDynViewElementSet` — reuse the existing LE `emitReadBytes`/`emitWriteBytes`
engine via nested `if`-chains over the 9 `TA_CTOR_KINDS` (each arm carries the
STATIC per-kind width/signedness/float descriptor; the Uint8Clamped arm applies
ToUint8Clamp before the write). The address is `byteOffset + i*elemSize(kind)`
with a runtime `elemSize` (`pushElemSizeForKind`) and the effective (length-
tracking) bound from `pushTaDynViewEffectiveLen`. Get returns externref (boxed
number in-bounds, `undefined`/`ref.null.extern` OOB); Set no-ops OOB (§10.4.5.16).

### Hazard guard (opus-3054-de flag)

The generic dynamic index path is SHARED with boxed plain-array `any` receivers.
Both functions `ref.test $__ta_dyn_view` FIRST and, on a miss, fall through to the
EXACT existing behavior (`__extern_get_idx` for read, `__extern_set` for write) —
so plain-array `any[i]` get/set is byte-behavior-preserved (verified: identical
result with and without a dyn view in the module). Index and value are each
compiled ONCE (single-evaluation) and shared across both branches.

### Ordering hazard + fix (the non-obvious part)

The `$__ta_dyn_view` type registers LAZILY at the construct. A helper like
`ToNumbers(array)` that reads `array[i]` is compiled BEFORE the construct, so a
naive `taDynViewTypeIdx >= 0` gate would MISS every cross-function read (the
common test262 shape) — it returned 0. Fixed with a module pre-scan
(`sourceHasDynamicTaConstruct` in `index.ts` → `ctx.moduleUsesDynTaView`) that
detects a dynamic `new <ctorVar>(bufferArg)` and enables the codec arm for ALL
functions; the type is then registered on demand (`getOrRegisterTaDynViewType`)
at whichever site compiles first. Byte-inert: the flag is false for any module
without the construct, so no new instruction is emitted and the type is never
registered (all new emit paths are behind the flag). Static `new Uint8Array(buf)`
is excluded (handled by the static-view path), as are user-class callees.
