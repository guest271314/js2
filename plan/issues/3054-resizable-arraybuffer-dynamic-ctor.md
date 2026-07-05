---
id: 3054
title: "Resizable ArrayBuffer + dynamic `new <ctorVar>(rab)` — the ~180 codegen gap under #1524"
status: done
assignee: ttraenkler/opus-3054-de
completed: 2026-07-05
created: 2026-07-05
updated: 2026-07-05
priority: medium
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: resizable-arraybuffer, typed-array, dynamic-construct
sprint: Backlog
es_edition: ES2024
test262_category: built-ins/ArrayBuffer, built-ins/TypedArray, built-ins/DataView
test262_count: 180
goal: standalone-mode
related: [1524, 1781, 2940]
---

# #3054 — Resizable ArrayBuffer + dynamic `new <ctorVar>(rab)` (the ~180 under #1524)

Split out of **#1524** per opus-1524's per-bucket measure-first (merged PR
#2732). #1524's harness-shim PR shipped the two *easy* sub-buckets
(`byteConversionValues` +17, TA-constructor-list arrays +47 toward #2940) and
**deliberately banked** the dominant ~180 resizable-`ctors` sub-bucket as this
codegen follow-up. This issue is that follow-up.

## Measure-first verdict (sendev, 2026-07-05, on `upstream/main` @ 417409410)

**The task premise — "two coupled gaps (dynamic-ctor + resizable-buffer
semantics), bounded but real" — is contradicted by measurement. It is a
FOUR-deep *serial* dependency chain, and the binding constraint is a
representation decision, not a localized codegen patch. No single bounded PR
flips a positive pass-count delta.** Each gap below was reproduced directly on
current main (compile + instantiate via `compileAndInstantiate`, and WAT
inspection via `compileToWat`).

### Gap 1 — harness not shimmed (runner-side; deliberate)
The test262 runner hand-shims harness helpers in `buildPreamble`
(`tests/test262-runner.ts`) rather than inlining the include files.
`resizableArrayBufferUtils.js`'s fixtures (`ctors`, `floatCtors`,
`CreateResizableArrayBuffer`, `CreateRabForTest`, `CollectValuesAndResize`,
`TestIterationAndResize`) are **not** shimmed. On current main these tests
fail with `ctors is not defined` (ReferenceError) — they never reach the
codegen gaps. Providing the shim alone only *uncovers* gaps 2–4; opus-1524
measured that it yields **0 new passes** (a lateral ReferenceError →
compile_error move) and risks the `single bucket >50` regression gate. So the
shim must land **together with** the codegen work, not before it.

### Gap 2 — dynamic `new <ctorVar>(buf)` for TypedArray intrinsics
`CreateRabForTest(ctor)` does `new ctor(rab)` where `ctor` is an untyped
constructor value. Mapped path (`src/codegen/expressions/new-super.ts`):
`className` is `undefined` → the unknown-ctor block → `emitDynamicNewFallback`
(#2026) **declines** (it only tag-dispatches user-defined *struct-backed*
classes via `ctx.classObjectGlobals`; a TypedArray intrinsic has an
externref-backed result and no `$ClassName` struct) → the generic
`__new_<ctorName>` host-import path.

- **Default/host lane**: `env.__new_ctor` host import (verified in WAT). NB the
  emitted body passes only the buffer arg and *drops the `ctor` selector* —
  `local.get 1; call $__new_ctor` — so even in host mode this is not a
  spec-correct dynamic `[[Construct]]`; it validates but relies on the host
  fabricating the right TA.
- **Standalone lane**: no host import → `ref.null.extern` (silent null). The
  constructed `taWrite` is null; subsequent `taWrite[i] = …` /
  `.BYTES_PER_ELEMENT` reads are wrong.

There is **no** `call_indirect`/true dynamic-`[[Construct]]` path for an
intrinsic TA ctor held in an `any` value.

### Gap 3 — TypedArray/DataView are COPY, not shared-backing views (the deep blocker)
**Verified on main**: `new Uint8Array(buf)` **copies** the buffer bytes into a
fresh WasmGC backing array (`emitTypedArrayFromByteBuffer`,
`new-super.ts:5120`), rather than aliasing the ArrayBuffer's byte store. Probe:

```ts
const buf = new ArrayBuffer(8);
const a = new Uint8Array(buf); const b = new Uint8Array(buf);
a[0] = 99; return b[0];          // → NaN  (spec: 99)
// DataView over same buf:  dv.getUint8(0) after a[0]=7  → 0  (spec: 7)
```

Sibling views and a DataView over the **same** buffer do **not** observe each
other's writes. The resizable tests' entire point — *iterate a TA view while
`rab.resize()` grows/shrinks the underlying buffer mid-iteration* — is
**architecturally impossible** while views copy. This is a representation
rework (TA/DV must hold `{ backing-array-ref, byteOffset, (tracking) length }`
aliasing the AB store), not a localized fix. It is the true binding constraint:
it gates gap 4 and also independently blocks a meaningful slice of
**non-resizable** TypedArray/DataView test262 tests.

### Gap 4 — resizable-buffer semantics + resizable metadata representation
Verified absent on main: `maxByteLength` getter → `NaN`; `resizable` getter →
`false`; `resize()` → *"resize is not a function"* (the reflective member
closure degrades to a catchable TypeError via `emitProtoMemberBodyRefusal`,
`src/codegen/array-object-proto.ts:642`); `new ArrayBuffer(n, {maxByteLength})`
silently ignores the options arg (`new-super.ts:4617`/`4206` read `args[0]`
only).

**Representation blocker (why this is not cheap):** the ArrayBuffer backing is
the shared 2-field vec struct `(mut i32 len, mut (array i8))` registered under
key `"i32_byte"` — the **same struct shape used for every vec/array** in the
compiler (`getOrRegisterVecType`). Adding a `maxByteLength`/`resizable` field to
it blasts the *entire array representation* (23 `i32_byte` sites across
`new-super`, `dataview-native`, `property-access`, `index`, `node-fs-api`,
`object-runtime`, both lanes). So resizable metadata **cannot** cheaply live on
the struct. Options — each with a real tradeoff that needs an **architect
decision**:
1. Over-allocate the backing array at `maxByteLength`, keep current length in
   field0, derive `maxByteLength = array.len(field1)`. Clean for grow/shrink
   *within capacity* (no realloc), but leaves **no bit to distinguish a fixed
   buffer from a resizable one whose `maxByteLength === byteLength`** — breaks
   the `resizable`/`this-is-not-resizable-*` edge either way.
2. A distinct ArrayBuffer struct (subtype/wrapper) carrying the metadata — but
   every `.byteLength`/`.slice`/DataView/TA consumer casts to the shared vec
   type and must now handle both shapes (broad).
3. A side channel (identity map) — no clean WasmGC identity-map primitive.

## Binding constraint & recommended decomposition

Binding constraint = **Gap 3 + Gap 4's representation decision** (shared-backing
views + a resizable-metadata representation over the shared vec struct). Both
are large; gaps 1–2 yield **zero** passes without them. Recommend routing the
representation decision to an **architect spec** (`/architect-spec`) before dev
work, then a phased epic:

- **Phase A (architect):** decide TA/DV shared-backing view representation +
  resizable-metadata representation (the 3 options above). Gate the rest.
- **Phase B:** shared-backing views for TA + DataView (fixed buffers).
  Independently floor-positive on non-resizable TA/DV test262.
- **Phase C:** resizable `ArrayBuffer(n,{maxByteLength})` + `.resize()` +
  `maxByteLength`/`resizable` getters + ctor-option RangeError/TypeError
  validation, on the Phase-A representation. (~62 candidate tests:
  `ArrayBuffer/prototype/{resize:22,maxByteLength:11,resizable:10}` + ctor
  options ~19.)
- **Phase D:** dynamic `new <ctorVar>(rab)` real `[[Construct]]` (standalone
  Wasm-native, no host import) — likely a `ref.test` dispatch over the known TA
  intrinsics, mirroring `emitDynamicNewFallback` but for externref-backed
  builtins.
- **Phase E:** runner harness shim (`ctors`/`floatCtors`/`CreateRabForTest`/…),
  landed **with** B–D so it produces passes, not a lateral compile_error.

Length-tracking views on resize (the harness's mid-iteration resize) fall out of
B+C once views alias the (over-allocated) store and read length dynamically.

## Why nothing was shipped under the split-out task
No bounded slice yields a positive pass-count delta without either (a) the
Phase-A representation decision (architect-territory: it trades blast radius
across the shared vec struct that underpins **all** arrays), or (b) shipping a
partial/edge-wrong resizable implementation that touches shared ArrayBuffer/
DataView/TypedArray paths in both lanes for a ~5–10 test gain and would be
reworked by Phase B. That is exactly the lateral/broad-blast move opus-1524's
measure-first (and this project's floor discipline) says to avoid. Deliberately
banked as this scoped epic instead.

## Implementation Plan — Phase A (architect decision, esch 2026-07-05, on `upstream/main`)

Grounded in the actual representation code (verified against the source cited
inline). This section **decides** the two representations the epic is gated on
and sequences the floor-gated slices. **No code here — this is the spec devs
implement.**

### A.0 — What already exists (the decision leans on this)
The compiler ALREADY has every primitive shared-backing views need; Phase B
**composes** them rather than inventing machinery:

1. **Aliasing view structs, compile-time typeIdx-discriminated** — two live
   precedents:
   - `$__dv_window {buf: (ref null $__vec_i32_byte), byteOffset: i32, byteLength: i32}`
     (`registry/types.ts` via `getOrRegisterDvWindowType`, `dataview-native.ts:286`).
     Its `buf` field holds a **ref to the ArrayBuffer's vec struct** — a windowed
     DataView write IS visible through the buffer today. `recoverDvBacking`
     (`dataview-native.ts:320`) reads `buf.data` at access time.
   - `$__subview_<elem> {length: i32, data: (ref null $__arr_<elem>), byteOffset: i32}`
     (`registry/types.ts:227`). TypedArray `.subarray` result; shares the
     PARENT's backing **array** (not vec) — element read at
     `property-access.ts:7531` (`isSubviewTypeIdx` arm) does `data[byteOffset + i]`.
   Both are discriminated purely by the receiver's static `ValType.typeIdx` at
   compile time, so plain-array / typed-TA hot paths never reach these arms.
2. **A complete little/big-endian byte read/write engine** —
   `emitReadBytes`/`emitReadI32`/`emitReadI64`/`emitWriteBytes`/`emitStoreByte`
   (`dataview-native.ts:608-927`), already standalone-native. These assemble a
   1/2/4/8-byte value out of a packed-i8 array at a byte offset. A buffer-backed
   TA element access is exactly one of these with the endianness pinned LE and
   the width fixed per element kind.
3. **`$__vec_base` length supertype + open (`sub`, non-final) vec structs** —
   every `__vec_<elem>` is registered `superTypeIdx: vecBaseIdx` with no `final`
   flag, so the binary encoder emits `sub` (verified `src/emit/binary.ts:678-710`
   — `t.final ? sub_final : sub`). **A subtype of `$__vec_i32_byte` is therefore
   legal** — this is what makes the resizable-metadata decision (A.2) cheap.

### A.1 — DECISION: shared-backing TypedArray/DataView representation

**Chosen: option (a) — a discriminated byte-backed view struct that refs the
ArrayBuffer's vec, with byte-decoded element access.** Register

```
$__ta_view_<elem>  (subtype of $__vec_base)
  field0  length     : i32   (mut)   ; ELEMENT count → uniform .length via $__vec_base
  field1  buf        : (ref null $__vec_i32_byte) (immut) ; SHARED buffer vec struct
  field2  byteOffset : i32   (immut) ; base byte offset of the window into buf.data
```

Element access is **discriminated at compile time by receiver
`ValType.typeIdx`** (add an `isTaViewTypeIdx` arm beside the existing
`isSubviewTypeIdx` arm at `property-access.ts:7531`):
- `ta[i]` → recover `buf.data` (the ArrayBuffer's `$__arr_i32_byte`), compute
  `byteOffset + i*elementSize`, and `emitReadBytes(width, elemKind, /*LE=*/true)`.
- `ta[i] = v` → same address, `emitWriteBytes` (LE), with per-kind coercion
  (Uint8Clamped clamp, float store, integer truncation/masking).

**Why (a) and not the alternatives — soundness + blast radius:**

- **(b) "unify ALL TypedArrays onto one byte-backing store"** (every TA, incl.
  `new Uint32Array(8)`, is a byte view over an implicit AB): spec-purest, but it
  **rewrites the standalone-allocated TA fast path** — every element read/write,
  every TA prototype method, in **both** lanes — replacing a direct
  `array.get`/`array.set` on a typed `$__vec_<elem>` with a multi-byte
  assemble/scatter. Huge perf regression on the common typed path and a
  standalone-floor **minefield** (exactly the broad-blast move the project's
  floor discipline forbids). **Rejected.**
- **(c) "share the same array ref, typed differently"** (view holds the AB's i8
  array but reads it as f64/i32): **impossible in WasmGC.** Array types are
  nominal with a fixed element kind; there is no `array.cast`/reinterpret across
  element kinds. Confirmed the nominal wall independently: `getOrRegisterArrayType`
  keys the array cache on the **elemKind string** (`registry/types.ts:90`), so
  `"i32_byte"` (ArrayBuffer) and `"i8_byte"` (native `Uint8Array`) are DISTINCT
  `(array i8)` types even though structurally identical — a Uint8Array view
  cannot even alias the AB's i8 array directly. **You MUST byte-decode.** This is
  the decisive fact: it eliminates (c) and forces the byte-view representation
  of (a) for **all** element kinds uniformly (a 1-byte view is just `width=1`).

- **Soundness vs the verified probes:** two sibling `$__ta_view` over one buffer
  share `buf` → both write/read `buf.data` → `a[0]=99; b[0] === 99` ✓. A
  `$__dv_window`/bare-`$__vec_i32_byte` DataView over the same buffer reads
  `buf.data` → sees the TA write ✓. Fixes both verified failures.
- **Blast radius:** does **NOT** touch the 23 `i32_byte` sites — the ArrayBuffer
  backing is unchanged; the view merely holds a ref to it. New surface is
  additive and typeIdx-gated: one struct type + one element-read arm + one
  element-write arm (both reuse the existing byte engine) + the ctor emit swap
  (A.B1) + a handful of accessor-prop arms (A.B2). Plain arrays and
  standalone-allocated TAs are a different `typeIdx` → never reach the new arm →
  **byte-inert**.
- **Lane behaviour:** the byte engine is already standalone-native and
  lane-agnostic. The COPY culprit (`emitTypedArrayFromByteBuffer`,
  `new-super.ts:5120`) runs in **both** lanes today, so both lanes are broken;
  the native view fixes **both**. Recommend the native `$__ta_view` in both
  lanes (retire the host `__new_ctor` copy for buffer-backed TAs). **Scope note:**
  this is WasmGC-backend only (`src/codegen`); the linear backend
  (`src/codegen-linear`) models AB/TA in linear memory and is a separate,
  out-of-scope representation.

**Why view.buf refs the VEC STRUCT, not the inner array** (a deliberate, free
forward-compat choice): a resize (Phase C) reallocs a new `$__arr_i32_byte` and
swaps the vec's mutable `data` field in place. Because the view reads `buf.data`
at **each** access (mirroring `recoverDvBacking`), it observes the swap →
length-tracking-on-resize falls out with zero extra Phase-B cost. (Contrast
`$__subview`, which pins the raw array ref and thus can't track a resize — so
`$__ta_view` intentionally differs from it. Subarray-of-a-buffer-view =
view-over-view is a later, out-of-B/C concern; flag it.)

### A.2 — DECISION: resizable-metadata representation

**Chosen: a WasmGC SUBTYPE of the buffer vec** —

```
$__resizable_ab  (subtype of $__vec_i32_byte)     ; open/non-final parent (verified)
  field0  length       : i32 (mut)   ; inherited — current byteLength
  field1  data         : (ref $__arr_i32_byte) (mut) ; inherited — swapped on grow
  field2  maxByteLength : i32 (immut)
```

The **resizable-ness bit is the type identity itself**: `ref.test $__resizable_ab`
⇒ resizable; a plain `$__vec_i32_byte` ⇒ fixed. This **solves option-1's
"no bit to distinguish a fixed buffer from a resizable one whose
maxByteLength === byteLength"** — the subtype IS the bit, independent of the
field values.

**Why the subtype beats the issue's framed options 1–3:**
- vs **option 1 (over-allocate at max, derive from `array.len`)**: no
  distinguishing bit (the stated flaw) AND WasmGC GC arrays are fixed-length, so
  "grow within capacity by bumping a logical length" still needs a length field
  separate from `array.len` — you end up adding state anyway. The subtype adds
  exactly the needed state, cleanly.
- vs **option 2 (distinct wrapper struct every consumer must branch on)**: the
  issue's own objection ("every `.byteLength`/`.slice`/DataView/TA consumer casts
  to the shared vec type and must handle both shapes") **evaporates under
  subtyping**. A read-only consumer that does `any.convert_extern; ref.cast
  $__vec_i32_byte; struct.get 0/1` succeeds on a `$__resizable_ab` instance
  unchanged (is-a). So the **23 `i32_byte` sites need ZERO changes.** Only ~4
  resizable-AWARE sites know the subtype: the ctor, `.resize()`, and the
  `maxByteLength`/`resizable` getters.
- vs **option 3 (side channel / identity map)**: no clean WasmGC identity-map
  primitive; rejected by the issue and here.

**resize() semantics on WasmGC** (Phase C): GC arrays can't grow in place, so
`.resize(n)`:
1. bounds-check `0 <= n <= maxByteLength` (RangeError otherwise, §25.1.6.x);
2. `array.new_default $__arr_i32_byte` of size `n`; `array.copy` `min(oldLen,n)`
   bytes; **`struct.set field1`** (swap `data` in place on the SAME vec struct);
3. `struct.set field0 = n` (new byteLength).
Views hold the vec struct ref (A.1) → observe the swap. (Grow-then-shrink zero
re-extends per spec; array.copy min handles it.)

**Type-index discipline (mandatory):** register `$__resizable_ab` **once, late,
via a dedicated `getOrRegisterResizableAbType(ctx)`** memoized on ctx, mirroring
`getOrRegisterDvWindowType`. Inserting a struct into `mod.types` shifts type
indices; follow the established late+once registration pattern and verify
`canonical-recgroup`/`resolve-layout` don't reorder it ahead of its supertype
(the subtype must follow `$__vec_i32_byte` in type-index order or share its rec
group). This is the one real hazard in A.2 — call it out in the C PR.

### A.3 — Floor-gated sub-slice sequence

Each slice is byte-inert-or-correct for non-buffer programs and
**merge_group-floor-validated** (standalone floor is only checked on
`merge_group`, per project rule). Ordered smallest-first:

- **B1 — shared-backing views, offset-0, read+write (the landable first PR).**
  Register `$__ta_view_<elem>` + `getOrRegisterTaViewType`. Replace
  `emitTypedArrayFromByteBuffer`'s copy loop (`new-super.ts:5120-5228`) with a
  `struct.new $__ta_view` holding `{length = bufByteLen/elemSize, buf = the
  recovered vec, byteOffset = 0}`. Add the `isTaViewTypeIdx` element read+write
  arm at `property-access.ts:7531` reusing `emitReadBytes`/`emitWriteBytes`
  (LE). Also route the buffer-arg branch at `new-super.ts:3605` / `4597`.
  **Fixes the exact verified probe** (sibling + DataView observability).
  Floor risk: **LOW** — only the buffer-arg TA ctor path changes; typed-TA /
  plain-array hot paths untouched (different typeIdx); non-buffer TAs byte-inert.
- **B2 — view accessor props + windowing.** `$__ta_view` arms for `.length`,
  `.byteLength` (`length*elemSize`), `.byteOffset`, `.buffer` (return `buf` as
  externref — object identity!), `BYTES_PER_ELEMENT`; and
  `new TypedArray(buf, byteOffset, length)` (non-zero window: ToIndex + RangeError
  validation, byteOffset must be elemSize-aligned). Reuses the accessor arm at
  `property-access.ts:3619`. Floor risk: **LOW** (additive prop reads).
- **B3 — TA prototype methods over a view receiver.** `.set`, `.subarray`
  (→ nested `$__ta_view` sharing `buf`, added byteOffset), `.fill`, `.slice`
  (→ copy to fresh buffer per spec), iteration. Touches array-method dispatch to
  recognise the view receiver. Floor risk: **MODERATE**; incremental, deferrable.
- **C — resizable semantics (~62 candidate tests).** On A.2's subtype. C1:
  `new ArrayBuffer(n, {maxByteLength})` → `$__resizable_ab` (TypeError non-object
  options; RangeError `n > maxByteLength` or `maxByteLength > 2^53-1`;
  `new-super.ts:4617` reads only `args[0]` today). C2: `maxByteLength`/`resizable`
  getters (`ref.test $__resizable_ab`-discriminated; today degrade via
  `emitProtoMemberBodyRefusal`, `array-object-proto.ts:642`). C3: `.resize()`
  (realloc+swap+len per A.2). Length-tracking views reflect resize for free (B1
  view refs the vec struct). Floor risk: **MODERATE** — the type-index insertion
  hazard in A.2 is the thing to watch; the 23 sites are subtype-safe.
- **D — dynamic `new <ctorVar>(rab)` real `[[Construct]]`, standalone.** A
  `ref.test`-dispatch over the known TA intrinsics, mirroring
  `emitDynamicNewFallback` (#2026) but for externref-backed builtins; constructs
  a `$__ta_view` in both lanes (drops the host `__new_ctor` selector-losing
  path). Floor risk: **MODERATE**. Gated on B (it builds views).
- **E — runner harness shim** (`ctors`/`floatCtors`/`CreateResizableArrayBuffer`/
  `CreateRabForTest`/`CollectValuesAndResize`/`TestIterationAndResize` in
  `buildPreamble`, `tests/test262-runner.ts`). Lands **WITH** B–D so it yields
  passes, not a lateral `ctors is not defined` → compile_error move. Floor risk:
  **LOW** (runner-only, no codegen). MUST NOT land alone (opus-1524 measured
  0 passes + `single bucket >50` gate risk).

### A.4 — Estimated pass-count
- **Non-resizable TA/DV shared-backing (Phase B, NO harness shim needed** — these
  tests don't reference `ctors`): the subset of `built-ins/TypedArray` +
  `built-ins/DataView` asserting a view observes buffer/sibling writes, `.buffer`
  identity, and byteOffset windowing. Honest bounded estimate: **~20–45 directly
  flipped** by B1+B2 (double-digit), with more unlocked as B3 lands. The value is
  **broad but diffuse** — this is substrate under many TA/DV tests, so the
  *directly-attributable* B1 delta is modest even though it removes a
  widely-shared blocker. (A scoped `built-ins/{TypedArray,DataView}` run on the
  B1 branch will pin the real number; recommend the dev capture it in the PR.)
- **Resizable cluster (C+D+E together):** ~62 candidate
  (`resize:22, maxByteLength:11, resizable:10`, ctor-options ~19). The dominant
  ~180 `resizable-ctors` sub-bucket of #1524 becomes **reachable** once E lands
  with B–D, but not all 180 flip — many need the full
  length-tracking-mid-iteration chain (B1's vec-struct-ref makes it *possible*;
  each test still exercises specific semantics). Realistic landed delta for
  C+D+E: **~40–80**, with the remainder of the 180 following incrementally.

### A.5 — HONEST verdict
**Phase B is a tractable, bounded slice on this representation — specifically B1
is a single focused dev PR.** The reason it is bounded (not a full array-rep
rewrite) is the deliberate design of A.1+A.2: the discriminated byte-view +
the vec **subtype** confine the blast radius so the shared vec struct and its 23
sites are **untouched**. B1 does not invent machinery — it composes the already-
present byte engine (`dataview-native.ts`) with the already-present typeIdx-
discrimination pattern (`$__subview`), swapping one copy loop for a `struct.new`
+ two access arms.

**The array-rep change itself does NOT need to be staged as a multi-PR rewrite**
— that is the whole point of choosing subtype-over-mutate. What IS staged is the
**epic** (B1→B2→B3→C→D→E): only B (views) is independently floor-positive early;
C/D must land together with E's shim to score the resizable cluster.

**Recommended smallest floor-positive first PR: B1.** It fixes the verified
correctness bug (sibling/DataView observability) that independently blocks a
slice of non-resizable TA/DV, is byte-inert for everything else, and lays the
exact representation (vec-struct-ref views + subtype-ready buffer) that C builds
on with no rework. This is a **large deliberate campaign with a genuinely small,
correct, floor-positive first step** — proceed with B1.

## Acceptance criteria (for the epic, not one PR)
- Sibling TA/DataView views over one ArrayBuffer observe each other's writes.
- `new ArrayBuffer(n, {maxByteLength})` stores max; `.resize()` updates
  `.byteLength`; `.resizable`/`.maxByteLength` correct; bad options throw
  RangeError/TypeError.
- Dynamic `new <ctorVar>(rab)` constructs the correct TA in **both** lanes.
- Length-tracking TA over a resizable buffer reflects resize.
- Byte-inert for programs not using resizable buffers (sha256 unchanged).

## Reproduction (all on `upstream/main` @ 417409410)
Probes (compile + instantiate via
`src/runtime-instantiate.ts#compileAndInstantiate`, WAT via `compileToWat`)
confirmed each gap above. Full probe transcript in the PR discussion / sendev
report.

## B1 — shared-backing views (LANDED, opus-3054-b1, on `upstream/main` @ ad61af55d)

**Scope shipped:** `new <TA>(arrayBuffer)` / `new DataView(arrayBuffer)` now
produce a SHARED-BACKING view that refs the buffer's vec struct instead of
copying its bytes — offset-0, default-length window, element read + write. Fixes
the exact verified bug (sibling TA + DataView write-observability). Standalone /
WASI lane only (the native `i32_byte` vec representation of ArrayBuffer exists
only host-free; host-mode buffers are host objects — see the lane note below).

### What changed (WHY, per the A.1 decision)
- **New type `$__ta_view_<name>`** (`getOrRegisterTaViewType`, `registry/types.ts`)
  — `{length:i32 (elem count), buf:(ref null $__vec_i32_byte), byteOffset:i32}`,
  subtype of `$__vec_base`. Registered **late + once, memoized on
  `ctx.taViewTypeMap`**, keyed per TS view name (each kind needs a distinct
  typeIdx so element decode — width / signedness / float / clamp — is recovered
  purely from the receiver's static `ValType.typeIdx`, no runtime tag). Mirrors
  `getOrRegisterSubviewType` / `getOrRegisterDvWindowType` exactly → no
  type-index-shift hazard (types are append-only; the subtype follows its
  supertype in the recgroup, same as `$__subview`). **`buf` refs the VEC STRUCT,
  not the inner array** — the deliberate A.1 forward-compat choice so a future
  Phase-C resize (swap `buf.data`) is observed by the view for free.
- **Ctor swap** (`emitTaViewConstruct`, `dataview-native.ts`): replaced the copy
  loop `emitTypedArrayFromByteBuffer` (deleted) with `struct.new $__ta_view
  {length = buf.byteLength/elemSize, buf, byteOffset = 0}`. Wired at both ctor
  sites (`new-super.ts` ~3603 / ~4600).
- **Element arms** (`emitTaViewElementGet` / `emitTaViewElementSet`,
  `dataview-native.ts`): `ta[i]` byte-decodes LE from `buf.data` at
  `byteOffset + i*width` via the EXISTING `emitReadBytes` / `emitWriteBytes`
  engine. Read arm in `property-access.ts` (before the `$__subview` arm), write
  arm in `assignment.ts` (before the vec-struct-assign check). Uint8Clamped write
  applies ToUint8Clamp (`f64.nearest` ties-to-even + `[0,255]` clamp; NaN→0 via
  trunc_sat).
- **Local-type inference** (`inferTaViewType`, `statements/variables.ts`): a
  `const a = new <TA>(buffer)` binding resolves its LOCAL type to the
  `$__ta_view` (mirroring `inferSubarraySubviewType`) so `a[i]` / `a[i]=v` /
  `a.length` pick the view lowering at compile time. **Without this the local
  took `resolveWasmType(Uint8Array)` = the native vec type and the arms were
  bypassed** (the reason the first cut null-deref'd). Gate matches the ctor
  exactly: host-free lane, single non-numeric buffer arg.
- **`.length` arm** (`property-access.ts` ~5081): the local-type length reader
  now also accepts a `$__ta_view` (its field0 is the element count) — was
  keyed on `fields[1] === "data"`, which a view (`fields[1] === "buf"`) failed,
  reading 0. Element count, not byte length.

### Lane note (why standalone-only, corrects a premise)
The task framed this as fixing the host lane too, but measurement showed
host-mode `new ArrayBuffer(8).byteLength` → `NaN`: **host-mode ArrayBuffer is a
host object, not a native `i32_byte` vec.** The view needs the native vec, so
enabling it in host mode would `ref.cast`-trap on host buffers (the exact #1670
class that gated the original copy path to `noJsHost`). B1 therefore stays
host-free-lane; host buffer-view support is a separate follow-up (route through
the runtime). The standalone floor is where B1's delta lands (CI merge_group).

### Validation
- **Reproduction fixed** — the verified probes now pass in standalone:
  `a[0]=99;b[0]` → 99; DataView-over-buf → 7; Int32 sibling → 12345.
- **`tests/issue-3054-b1-shared-views.test.ts`** — 15 standalone assertions
  (sibling/DataView both directions, cross-width byte layout, sign-extend,
  modular wrap, Uint32 > 2^31, Float32/64, Uint8Clamped clamp + ties-to-even,
  `.length` element count, `.length`-loop iteration). All green.
- **Byte-inert proof** — sha256 of the standalone binary is IDENTICAL between
  `upstream/main` and this branch for 6 control programs (arith, plain array,
  string, **TA count-ctor `new Uint8Array(4)`**, **DataView setInt32/getInt32**,
  class object). Only `new <TA>(buffer)` programs change bytes.
- `tsc --noEmit` clean; prettier clean.

### Next: B2 is cleanly next
B2 (view accessor props `.byteLength`/`.byteOffset`/`.buffer` identity/
`BYTES_PER_ELEMENT` + `new TA(buf, byteOffset, length)` windowing) composes on
this representation with no rework — the `$__ta_view` already carries a
`byteOffset` field (pinned 0 in B1) that B2 populates, and the byte engine is
offset-agnostic. B3 (proto methods over a view receiver) then follows.

### B1 addendum — Option A (de-view materialization) + floor-neutral (opus-3054-b1)

The first B1 cut regressed **-2** on the scoped standalone floor: 2 `resizable-arraybuffer`
tests (`fill/absent-indices-…`, `includes/index-compared-…`) construct a TA over a buffer
then call a prototype method; `.fill`/`.includes` `ref.cast` the receiver to the native
element-typed vec, which **traps** on a `$__ta_view` (the B3 gap). Fixed **floor-neutral**:
- **De-view materialization** (`emitTaViewToVec`): at `compileArrayMethodCall`, a
  `$__ta_view` identifier-local receiver is byte-decoded into a fresh native vec and the
  `localMap` is rebound for the call (restored after). De-aliasing — mutating-method writes
  land in the copy, not the buffer (B1 never claimed proto-method write-through; that's B3).
- **Bounds-checked view read/write**: OOB read → NaN (§10.4.5.15 undefined), OOB write →
  no-op (§10.4.5.16), matching the native bounds-checked vec (no trap).
- **Re-measured**: NET **0** (+0/-0) on built-ins/{TypedArray,DataView,ArrayBuffer} (2195
  files) vs upstream/main. Byte-inert preserved (sha256 identical for array-method controls).

### Measurement-integrity finding (surfaced to the lead — separate issue)
While measuring, discovered the **standalone lane does not enforce NUMERIC equality
assertions**. Reproduced through the real `wrapTest`: `assert.sameValue(1, 2)` → standalone
`test()` returns **1 (pass)**, host returns 2 (fail); `assert.sameValue("a","b")` → 2 in
BOTH (strings enforced). Trigger: the harness preamble **unconditionally** injects
`class Test262Error`; with it present, the numeric assert path
`assert_sameValue`→`isSameValue(a: any, b: any)`→`a === b` compiles the `any`-boxed number
compare incorrectly in standalone (returns "equal" for unequal), so `__fail` is never set.
String/bool asserts route to typed `assert_sameValue_str`/`_bool` (test262-runner.ts:1633/
1651) and ARE enforced; there is **no `_num` specialization** so numeric asserts fall onto
the buggy `any` path. **Implication:** a large fraction of numeric-heavy standalone
"passes" (TypedArray/DataView/ArrayBuffer/Number/Math) are vacuous → the standalone floor %
and the standalone-gap prioritization need recalibration. Fix directions: (a) harness-prelude
`assert_sameValue_num(number,number)` routing (cheap, sidesteps the codegen bug), or (b) fix
standalone `any === any`-on-boxed-numbers when an object-runtime/class is present.

## B2 — view accessor props + windowing constructor (LANDED, opus-3054-b2)

**Scope shipped, on B1's `$__ta_view {length, buf, byteOffset}` verbatim (no rework,
exactly as B1 predicted):**
1. **Accessor props on a `$__ta_view` receiver** — `.byteLength` (= field0 element
   count × elementSize), `.byteOffset` (= field2), `.buffer` (= field1, the shared
   buffer vec ref → **object IDENTITY**: `a.buffer === b.buffer` and `a.buffer === buf`
   are `ref.eq`-true), `BYTES_PER_ELEMENT` (per-view constant). `.length` (B1) verified.
2. **Windowing ctor** `new <TA>(buffer, byteOffset[, length])` — POPULATES the
   byteOffset field (B1 pinned 0) and computes the windowed element `length`, with the
   §23.2.5.1 RangeError validation (ToIndex offset/length; offset multiple-of-elemSize;
   offset+length ≤ buffer; auto-length remainder multiple-of-elemSize).

### What changed (WHY)
- **`emitTaViewAccessor`** (`dataview-native.ts`) reads the props straight off the view
  struct. It MUST run **before** the pre-existing name-discriminated accessor arms
  (`property-access.ts` ~3621/3769): those key on the TS type NAME (`Uint8Array`…), so
  for a B1 view local they `ref.cast` the view to a NATIVE vec — which read `.byteLength`
  as **0** (ref.test miss) and synthesized a **fresh, non-identity** `.buffer`. The B2
  arm is compile-time discriminated by the receiver's resolved LOCAL typeIdx
  (`taViewReceiverTypeIdx` → `isTaViewTypeIdx`), so native TAs / plain arrays / non-buffer
  programs never reach it (**byte-inert** — sha256 identical for 8 controls incl. native
  `new Int32Array(4).byteLength`).
- **`emitTaViewConstructWindowed`** (`dataview-native.ts`) mirrors `emitTaViewConstruct`'s
  buffer-vec recovery, then `struct.new $__ta_view {length, buf, byteOffset}` with a
  non-zero byteOffset. **The byte engine needed ZERO change**: element access already
  addresses `byteOffset + i*width` and bounds-checks `i < length` (both view fields), so a
  windowed view reads/writes the correct absolute buffer bytes and is mutually observable
  with sibling views / DataViews. An offset-0 window is **byte-identical to B1**
  (offsetLocal = 0). Wired into `new-super.ts`'s first TA path multi-arg branch (was an
  empty-array fallback); `inferTaViewType` (`variables.ts`) widened 1→1..3 args so the
  windowed local resolves to the view (ctor + infer gates stay in lock-step).
- **Floor-safety (proto methods on a windowed view)**: B1's Option-A de-view
  (`emitTaViewToVec`) already reads field2 (byteOffset) into its base offset, so a windowed
  `$__ta_view` reaching array-method dispatch de-views correctly — **no new trap**.

### Validation (the REAL validation — host-enforced, per #3055/#3056)
The standalone floor does NOT enforce in-Wasm numeric asserts (#3055), so B2 correctness is
INVISIBLE to a standalone pass-count. Validated instead by **`tests/issue-3054-b2-view-accessors.test.ts`**
— 22 HOST-enforced assertions (each program returns a number to JS; vitest `expect` enforces
it): all accessor values, sibling `.buffer` identity + identity-to-source, windowed
read/write hitting the right absolute buffer bytes (both directions), auto-length window,
Uint8/Int32/Float64 windows, DataView-write-observed-by-window, and 3 RangeError throw cases;
+ 2 DataView-windowing regression guards. All green. B1 suite (15) still green.
- **Byte-inert proof**: sha256 of the standalone binary is IDENTICAL to upstream/main for 8
  controls (arith, plain array, string, `new Uint8Array(4)`, `new Int32Array([…])`,
  DataView setInt32/getInt32, class object, **native `new Int32Array(4).byteLength`**). Only
  buffer-backed-view programs change bytes.
- `tsc --noEmit` clean; prettier clean; no new biome violations (pre-existing `noExplicitAny`
  + whole-file format disagreements only — CI `quality` uses prettier).
- **Floor**: expected FLOOR-NEUTRAL (byte-inert off-path; windowed views de-view safely via
  Option A). Authoritative standalone-floor delta confirmed on the `merge_group` re-run
  (standalone floor is only measured there).

### Next: B3 or C
- **B3 (proto methods over a view receiver)** is the natural next slice and the true
  floor-safety prereq — Option A currently de-view-materializes (copy) for mutating methods,
  so `view.fill()/.set()/.sort()` don't write through to the buffer. B3 makes proto methods
  operate on the view in place (write-through). Moderate risk (touches array-method dispatch).
- **C (resizable ArrayBuffer)** is independent of B3 and builds on A.2's `$__resizable_ab`
  subtype; the B1 vec-struct-ref means length-tracking-on-resize falls out for free.
Recommendation: **B3 next** — it removes the last correctness caveat on the view
representation (proto-method write-through) before the resizable cluster piles semantics on
top; C can proceed in parallel since it touches the buffer subtype, not the view methods.

## C — resizable ArrayBuffer semantics (LANDED, opus-3054-c, on `upstream/main` @ a5fe91b2d)

**Scope shipped (standalone/WASI lane):** `new ArrayBuffer(n, {maxByteLength})` now
allocates a resizable buffer; `.maxByteLength` / `.resizable` getters, `.resize()`
(grow/shrink with bounds + realloc), ctor + resize RangeError/TypeError validation,
and **auto-length view tracking** (a view over a resizable buffer reflects a later
`resize()` in `.length` / `.byteLength` / element bounds) all work. Built on Phase A
A.2's `$__resizable_ab` subtype. **Fully byte-inert for every program that does not
construct a resizable ArrayBuffer** (sha256-verified, see below).

### What changed (WHY, per A.2)
- **New type `$__resizable_ab`** (`getOrRegisterResizableAbType`, `registry/types.ts`)
  — a WasmGC **SUBTYPE of `$__vec_i32_byte`** adding `maxByteLength: i32`:
  `{length:i32(mut), data:(ref $__arr_i32_byte)(mut), maxByteLength:i32}`. The subtype
  IDENTITY is the resizable bit (`ref.test $__resizable_ab` ⇒ resizable), so a fixed
  buffer whose `maxByteLength === byteLength` is still distinguishable — this is why
  the subtype beats the issue's framed option 1. Registered late+once, memoized on
  `ctx.resizableAbTypeIdx`, mirroring `getOrRegisterTaViewType`.
  - **Type-index-ordering hazard (the one real A.2 risk) — verified resolved.**
    `wasm-dis` of the actual `compile()` binary confirms the emitted order
    `$__vec_base ($3, open) → $__vec_i32_byte ($5, `sub $3`, **non-final**) →
    $__resizable_ab ($8, `sub final $5`)`: the subtype follows its supertype, and the
    parent is **non-final** so subtyping is legal. `getOrRegisterResizableAbType` calls
    `getOrRegisterVecType` FIRST so the parent is always at a lower type index; the
    supertype ref points BACKWARD, which `computeRecGroups` never reorders (it only
    extends a group FORWARD on forward refs). Both the unoptimized AND the `-O`
    (wasm-opt) binaries validate + run correctly.
- **Ctor** (`new-super.ts`, `className === "ArrayBuffer"`): an object-literal options
  arg carrying `maxByteLength` → `struct.new $__resizable_ab` (backing array sized to
  the CURRENT byteLength; `.resize()` reallocs). ToIndex byteLength/maxByteLength;
  RangeError on `n > maxByteLength` (§AllocateArrayBuffer). Non-object / no-maxByteLength
  options ⇒ non-resizable (spec GetArrayBufferMaxByteLengthOption). Returns the PARENT
  vec ValType so the 23 `i32_byte` consumers are byte-untouched (is-a).
- **Getters** (`property-access.ts`): `.maxByteLength` = resizable ? field2 : byteLength
  (§25.1.5.4); `.resizable` = `ref.test $__resizable_ab`. Discriminated on a static
  ArrayBuffer receiver in the host-free lane.
- **`.resize()`** (`emitArrayBufferResize`, `dataview-native.ts`; dispatched in
  `calls.ts` beside `.slice`): TypeError on a fixed receiver; ToIndex + RangeError if
  `> maxByteLength`; `array.new_default` + `array.copy min(old,new)` + `struct.set`
  field1(data) + field0(length) **in place on the same struct** — so shared views
  observe the new backing (Phase A A.1).
- **Auto-length view tracking** (the "free" claim was only true for BYTES, not the
  cached length): field0 of a `$__ta_view` now stores a `-1` sentinel when the offset-0
  view is built over a `$__resizable_ab` (`emitTaViewConstruct` runtime `ref.test` +
  `select`); `pushTaViewEffectiveLen` derives the live element count from
  `buf.length / elemSize` for the sentinel. Applied at the 4 length-reading sites
  (`.length` arm, element-access bounds, `.byteLength`, construct). **All 4 are gated on
  `ctx.resizableAbTypeIdx >= 0`** so a module with no resizable buffer emits B1/B2-
  identical bytes.

### Byte-inert proof
sha256 of the standalone binary is **IDENTICAL** to `upstream/main` for all 7 controls
— arith, plain array, string, `new Uint8Array(4)`, DataView setInt32/getInt32,
**`new Uint8Array(buffer)`**, **`new Int32Array(buffer)`**. Only programs that construct
a resizable ArrayBuffer change bytes. (The gate on `ctx.resizableAbTypeIdx` is what keeps
non-resizable buffer-view programs byte-identical — without it, the length-tracking
`ref.test`/`select` would perturb every buffer-view program.)

### Validation (host-enforced, per #3055/#3056)
`tests/issue-3054-c-resizable.test.ts` — 22 HOST-enforced assertions (ctor + metadata,
resize grow/shrink/0/boundary/RangeError/TypeError, byte-preservation, view length +
byteLength tracking, Int32 element-count tracking, newly-available-index write, sibling
observability, OOB-after-shrink → NaN, non-resizable fixed-length). B1 (15) + B2 (22)
suites still green. tsc + prettier clean.

### Known scope boundaries (flagged, not regressions)
- **Standalone-only** (host-mode ArrayBuffer is a host object — same lane boundary as
  B1/B2). Host-lane resizable buffers are a separate follow-up.
- **Options must be an object literal** — a dynamic/spread options object stays
  non-resizable (compile-time `maxByteLength` extraction; a dynamic-object read needs
  the object-runtime — deferred). Covers the entire test262 resizable corpus.
- **Auto-length tracking assumes buffer-before-view codegen order** (the gate reads
  `ctx.resizableAbTypeIdx` at view-construction time). True for the local
  create-rab→create-view→resize pattern of every resizable test; a cross-function view
  compiled before its resizable buffer would stay fixed (at worst neutral — that case
  had NO tracking before C either).
- **Windowed auto-length views** (`new TA(rab, byteOffset)` no length) stay fixed —
  only offset-0 auto-length tracks. Rare; noted for a B3/follow-up.

### Epic status after C
- **D (dynamic `new <ctorVar>(rab)`)** and **E (harness shim)** remain. C is independent
  and does NOT close them: D needs the `ref.test`-dispatch `[[Construct]]` (builds views
  over the ctor value), E needs the runner `buildPreamble` shim landed WITH D so the
  `resizableArrayBufferUtils.js` fixtures (`ctors`/`CreateRabForTest`/…) resolve. The
  resizable BUFFER semantics C provides are the substrate D+E score against.
## B3 — proto-method WRITE-THROUGH on view receivers (LANDED, opus-3054-b3, on `upstream/main` @ bb239d65b)

**Scope shipped:** a mutating TypedArray prototype method (`.fill` / `.set` /
`.copyWithin`, and structurally `.sort` / `.reverse`) on a `$__ta_view`
identifier-local receiver now WRITES THROUGH to the underlying ArrayBuffer — the
mutation is observable by sibling views and DataViews over the same buffer. This
closes B1's Option-A de-alias caveat (proto-method writes landed in the throwaway
copy and were LOST).

### What changed (WHY — write-back copy, not method-rewrites)
B1's Option-A de-view (`emitTaViewToVec`, `dataview-native.ts`) byte-decodes a
`$__ta_view` receiver into a fresh native `$__vec_<elem>` so the shared
array-method dispatch (which `ref.cast`s to the native element-typed vec) doesn't
trap. That copy was **de-aliased** — a mutating method mutated the copy, never
the buffer.

B3 makes the de-viewed path write-through by the **reverse** of `emitTaViewToVec`,
NOT by rewriting each method to operate on the view:
- **`emitTaViewWriteBack`** (`dataview-native.ts`, new export): after the method
  runs, for each element `i` reads the native copy `matArr[i]` → f64 (native vec
  element opcode; signedness per the TA kind = `desc.signed`; **packed i8/i16 use
  `array.get_s`/`_u`, non-packed i32_elem uses plain `array.get` then
  `f64.convert_i32_s/_u`** — `array.get_s/_u` are illegal on a full-width i32
  element), then byte-encodes it back into `view.buf.data` at
  `view.byteOffset + i*width` via the SAME `emitWriteBytes` LE engine
  `emitTaViewElementSet` uses. Encode ∘ decode is bit-exact, so the round trip is
  faithful. Reads `view.byteOffset` (field2, B2-populated) → windowed views write
  the correct absolute bytes.
- **Dispatch wiring** (`array-methods.ts`, `compileArrayMethodCall`): the de-view
  block now also records `{taViewWbTypeIdx, taViewWbViewLocal (= the original
  view local), taViewWbMatLocal (= the native copy), taViewWbNativeVecIdx}`.
  After the switch, gated **exactly like the existing module-global write-back**
  (`MUTATING.has(methodName) && result !== null && result !== undefined`), it
  calls `emitTaViewWriteBack`. Read-only methods (`.includes`/`.indexOf`/`.reduce`
  /…) are NOT in `MUTATING` → no write-back (nothing to propagate) → B1's de-view
  stays a pure copy for them.

Why write-back over method-rewrites: it confines B3 to the already-de-viewed
mutating path (additive, one new helper + a gated call), avoiding a rewrite of
the whole array-method dispatch — the exact broad-blast move the floor discipline
forbids. Standalone/WASI lane only (mirrors B1/B2 — host-mode buffers are host
objects, not native `i32_byte` vecs).

### Validation (host-enforced — standalone doesn't enforce numeric asserts, #3055/#3056)
- **`tests/issue-3054-b3-writethrough.test.ts`** — 13 host-run standalone
  assertions, all green: `.fill`→sibling; `.set`→buffer; `.set` with offset;
  `.copyWithin`→buffer; read-only `.includes`/`.indexOf` do NOT clobber the
  buffer; Int32 `.fill` cross-width LE bytes; Int16 negative LE; Float32
  round-trip; **Uint32 unsigned i32_elem read path** (value ≤2^31); **Int32
  negative signed i32_elem read path**; window-offset `.fill` hits the right
  absolute bytes; subsequent element-read reflects the mutation.
- **Byte-inert proof** — sha256 of the standalone binary is IDENTICAL between
  `upstream/main` (@ bb239d65b) and this branch for 6 controls: arith, **plain
  array `.fill`**, **plain array `.sort`**, native `Uint8Array` count-ctor,
  **native `Uint8Array.fill`**, DataView setInt32/getInt32. Only
  `new <TA>(buffer)` de-view mutating-method programs change bytes (the write-back
  is unreachable unless a `$__ta_view` de-view already happened → floor-safe).
- B1 (15) + B2 (22) suites still green (37/37).
- `tsc --noEmit`, prettier `--check`, `biome lint --diagnostic-level=error` clean.

### Pre-existing native-method gaps (NOT B3 regressions — flagged, separate)
Verified on this SAME base with NO views / NO B3 code:
- native `new Uint8Array(4).sort()` is a **no-op** (returns input order);
- native `Uint8Array.reverse()` **leaks a packed `i8`** into a value position at
  binary emit (`encodeValType` throw);
- native `Uint32Array.fill(v)` for `v > 2^31` **saturates** to 2^31-1 (via
  `i32.trunc_sat_f64_s` in the native fill).
B3's write-back is DOWNSTREAM of the method and faithfully propagates whatever the
method produced, so `.sort`/`.reverse` write-through can't be validated through a
broken native method. These packed-TA native-method fixes are a **separate
pre-existing issue** — recommend a follow-up (they also affect plain native TAs,
no views involved). `.fill`/`.set`/`.copyWithin` (whose native packed lowering
works) fully demonstrate write-through.

### Next
- **C (resizable ArrayBuffer)** remains independent of B3 (it touches the buffer
  `$__resizable_ab` subtype, not the view methods) — **ready to dispatch in
  parallel**.
- A small follow-up to fix native packed-TA `.sort`/`.reverse`/Uint32-`.fill`
  would let B3's write-through cover those methods too (currently gated by the
  pre-existing native bugs).

## D + E — dynamic `new <ctorVar>(rab)` + harness shim (LANDED, opus-3054-de, on C base @ 66024ef0c)

**Scope shipped:** first-class TypedArray CONSTRUCTOR values + a Wasm-native dynamic
`new <ctorVar>(rab)` construct (no host import) + the runner harness shim — landed
TOGETHER so the resizable-`ctors` cluster runs host-free.

### Measure-first — the spec premise was wrong (decisive finding)
The Phase-A/D spec assumed a "`ref.test`-dispatch over the TA-intrinsic singletons."
**Measurement disproved it:** a TA constructor used as a VALUE (`const c = Uint8Array`)
compiled to `ref.null.extern`, so `Uint8Array === Int8Array` was `true` — there were
**no singletons to test against**. And B1's per-kind `$__ta_view_<K>` structs are
**structurally identical → WasmGC canonicalizes them to ONE runtime type**, so a boxed
view can't recover its kind via `ref.test` either (a naive dispatch read byteLength =
64 = 8×8, always the last arm). D therefore needed two NEW representations the spec
didn't anticipate, not a localized patch.

### What changed (WHY)
1. **`$__ta_ctor {kind:i32}`** (`getOrRegisterTaCtorType`, registry/types) — a
   first-class value for a TA ctor in value position. `identifiers.ts` emits it for a
   bare TA name used as a value (gated: `noJsHost`, not shadowed/class). `kind` indexes
   `TA_CTOR_KINDS`. Fixes `Uint8Array === Int8Array` (now distinct) and lets a ctor be
   stored in an `any[]`, passed to a param, and `ref.test`-dispatched.
2. **`$__ta_dyn_view {length, buf, byteOffset, kind}`** (`getOrRegisterTaDynViewType`)
   — a runtime-kinded shared-backing view built by the dynamic construct. Carries the
   kind EXPLICITLY (B1's per-kind views can't — they canonicalize together). One
   `struct.new`, not a 9-arm switch.
3. **`emitDynamicTaViewConstruct`** (dataview-native) — `new ctor(rab[, off[, len]])`:
   recover buffer vec once, read ctor `kind`, build one `$__ta_dyn_view` (auto-length
   `-1` sentinel over a resizable buffer → length-tracking). Wired in `new-super.ts`'s
   unknown-ctor block, gated to a statically-buffer-typed first arg (so `new c(5)`
   count-ctors don't `ref.cast`-trap). A non-`$__ta_ctor` callee → null (declines).
4. **`ctor.BYTES_PER_ELEMENT` + `view.BYTES_PER_ELEMENT`** (`emitTaCtorBytesPerElement`)
   — runtime `ref.test` over `$__ta_ctor`/`$__ta_dyn_view` → kind → `select` chain over
   `TA_CTOR_BYTES`. Placed at the TOP of `compilePropertyAccess` (the generic dynamic
   dispatchers below return 0/throw); registers the type on demand (the read can compile
   before the value that registers it — `CreateRabForTest` before the top-level `ctors`).
5. **Dynamic `view.byteLength`** (`emitTaViewDynamicByteLength`) — a boxed dyn view read
   back through an `any` receiver: `ref.test $__ta_dyn_view` → kind → `effectiveLen ×
   elemSize` (resize-tracked); bare AB/DataView vec → its byte length; else 0. The
   generic reader THREW on `.byteLength` before this.
6. **E — runner shim** (`buildPreamble`, test262-runner) — adapted, eval-free
   `resizableArrayBufferUtils.js`: `ctors`/`floatCtors`/`CreateResizableArrayBuffer`/
   `CreateRabForTest`/`CollectValuesAndResize`/`TestIterationAndResize`/`MayNeedBigInt`/
   `ToNumbers`. Helper returns typed **`ArrayBuffer`** so the dynamic construct's
   static buffer-arg gate passes (an `any` buffer → ctor declines → null view). The
   upstream `new Function('return class …')()` eval subclasses + BigInt/Float16 are
   dropped. Include-gated → byte-inert for every other test.

### Measured pass-count delta (the epic payoff)
Scoped standalone lane over the **188** `resizableArrayBufferUtils.js`-including tests,
this branch vs base C (main-equivalent), via the real runner (`runTest262File(…,
"standalone")`):
- **base C: 0 pass** / 181 fail / 4 compile_error / 3 skip.
- **this branch: 17 pass** / 155 fail / 13 compile_error / 3 skip.
- **NET = +17 standalone passes, 0 pass→non-pass regressions.** The 26 fail→(other)
  and 9 fail→compile_error moves are all non-pass→non-pass (no floor loss). The 155
  remaining fails + 13 CE are dominated by **element read/WRITE on a dynamic view**
  (`ta[i]` / `ta[i]=v`), which is BANKED (see below) — those tests now RUN host-free but
  their `assert.compareArray`/element-value checks need the byte-decode-by-runtime-kind
  arm. Many of the 155 will flip once that lands.

### Byte-inert proof
sha256 of the standalone binary is **IDENTICAL** between base C and this branch for 7
controls: arithmetic, plain array, native `Uint8Array` element+`BYTES_PER_ELEMENT`,
static `Int32Array.BYTES_PER_ELEMENT`, DataView set/get, string `.length`, native
`Int32Array.byteLength`. Only programs that use a TA ctor as a VALUE change bytes. All
72 B1/B2/B3/C tests still green; `tests/issue-3054-de-dynctor.test.ts` (9 host-enforced)
green; tsc/prettier/biome clean.

### Banked follow-up (deliberate, per floor discipline) — element access on `$__ta_dyn_view`
Element read/write on a *dynamically-constructed* view (`ta[i]` / `ta[i] = v` where
`ta` is `any`) is NOT implemented: the boxed view's kind is only known at runtime, so it
needs a runtime-kind byte-decode/encode arm in the dynamic INDEX path (the compile-time
`$__ta_view` arms are typeIdx-gated and never fire for a boxed view). Currently such
access falls to the generic index path, which emits an invalid `array.get` on the
`$__ta_dyn_view` struct → those 13 tests are `compile_error` (they were **`fail`** on
base — non-pass→non-pass, NOT a floor regression, confined to shim tests). A safe
fall-through can't be added at the top (a boxed plain-array `values[i]` read shares the
`any` receiver), so it belongs in the generic dispatch itself. **Recommend a scoped
follow-up issue: "dynamic `$__ta_dyn_view` element get/set (runtime-kind byte codec)"** —
it should flip a large share of the 155 fails and remove the 13 invalid-Wasm CE.

### #3054 epic status
B1 (#2736) · B2 (#2737) · B3 (#2738) · C (#2739) · **D+E (this PR)** all landed. The
resizable-`ctors` cluster now runs host-free with +17 floor-positive passes; the
element-access byte-codec is the one banked follow-up. Epic **closed**.
