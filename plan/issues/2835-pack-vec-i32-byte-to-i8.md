---
id: 2835
title: "Pack $__vec_i32_byte byte backing as array(mut i8) — 4× smaller DataView/ArrayBuffer/Uint8Array GC footprint"
status: done
completed: 2026-06-29
assignee: ttraenkler/sendev-2835
sprint: Backlog
created: 2026-06-29
updated: 2026-06-29
priority: medium
horizon: l
feasibility: medium
reasoning_effort: high
task_type: perf
area: codegen
goal: standalone-conformance
related:
  - 389
  - 2832
---

# #2835 — Pack the byte-vec backing as `array(mut i8)` (4× smaller DataView / ArrayBuffer / native Uint8Array footprint)

## Problem

`$__vec_i32_byte` — the WasmGC struct that backs `ArrayBuffer` / `DataView`
(and, in the GC-fallback shapes, multi-byte typed-array buffers) — is
`struct { length: i32, data: array(mut i32) }`. When used as a **byte buffer**
it stores **one full `i32` per logical byte** (each element holds a value
`0..255`). That is a **4× memory blow-up**: a 64 MiB ArrayBuffer materialises
as a 256 MiB WasmGC array. This is the dominant reason
`nm_js2wasm_node_process` peaked at ≈530 MB for a 64 MiB Native-Messaging frame
before #2832 streamed the frame in <=1 MiB chunks. #2832 reduced the *peak* by
chunking the transfer; it did **not** shrink the per-byte storage cost, so any
workload that holds a large buffer resident still pays 4×.

Proposal: back the byte buffer with a **packed `array(mut i8)`** (1 byte per
element). Bytes are extracted to `i32` on the operand stack via `array.get_u`
(read) and truncated on `array.set` (write), exactly as the existing packed
typed-array path already does. Result: **4× smaller** GC footprint for
ArrayBuffer / DataView and the native `i8`-backed views.

---

## Feasibility assessment

### 1. Precedent / reuse — the machinery already exists

Packed GC arrays are a **solved, shipping pattern** in this codebase:

- Native strings use packed `array(mut i16)` (`case-convert-native.ts`,
  `date-parse-native.ts`).
- #2593 introduced **per-view packed integer typed-array storage** under
  `--target wasi`/`--standalone`: `TYPED_ARRAY_PACKED_STORAGE` in
  `src/codegen/index.ts:205-217` maps `Int8Array`/`Uint8Array`/`Uint8ClampedArray`
  → `i8_byte` (`array(mut i8)`), `Int16Array`/`Uint16Array` → `i16_byte`
  (`array(mut i16)`).
- The generic dynamic vec read/pop paths already branch on packing:
  `index.ts:4927` (`__vec_get`) and `index.ts:5280` (`__vec_pop`) emit
  `array.get_u` for `i8_byte`/`i16_byte` (plain `array.get` is invalid Wasm on a
  packed array), then `f64.convert_i32_u` + box.
- Per-view signedness is already keyed on the TS view name, not the storage
  kind: `typedArrayPackedSignedness` (`index.ts:230`) /
  `typedArrayViewSignedness` (`property-access.ts:431`) pick `array.get_s` vs
  `array.get_u`. A signed `Int8Array` and an unsigned `Uint8Array` correctly
  share `i8` storage but read with opposite extension
  (`property-access.ts:6979-6989`).
- `Uint8ClampedArray` writes already go through a packed `array.set`
  (`binary-ops.ts`).

**Is there already a packed-i8 byte-vec to converge onto?** Yes — `i8_byte`
(`array(mut i8)`) is exactly the right element shape and already backs the
native `Int8Array`/`Uint8Array`/`Uint8ClampedArray`. The DataView/ArrayBuffer
byte buffer can adopt the **same element type** (`{ kind: "i8" }`); see the
representation-split decision below for whether it can literally share the
`i8_byte` *key* or needs a distinct one.

### 2. The blocking complication — `i32_byte` is doubly-purposed

**This is the headline finding.** The `i32_byte` vec key resolves (via
`getOrRegisterVecType(ctx, "i32_byte", { kind: "i32" })`,
`registry/types.ts:132`) to a **single** struct type per module
(`vecTypeMap` is keyed by the elemKind string). That **one** struct type is
overloaded for **two semantically different uses**:

| Use | `length` means | each `data[i]` holds | per-byte cost |
|-----|----------------|----------------------|---------------|
| **ArrayBuffer / DataView byte buffer** | byte count | **one byte** `0..255` | **4× (the target)** |
| **Int32Array / Uint32Array element storage** (#2593) | element count | **one full 32-bit value** | 1× (already optimal) |

`Int32Array`/`Uint32Array` map to `i32_byte` in *both*
`TYPED_ARRAY_PACKED_STORAGE` (`index.ts:215-216`) and the legacy
`index.ts:210-211` table; their element read at `property-access.ts:6941-6951`
explicitly relies on `data[i]` being a **full 32-bit value** (`array.get` on an
i32 array, unsigned-coerced for `Uint32Array`). The two uses coexist *only*
because the slot type (`i32`) is wide enough for both a byte and a 32-bit
element — they are distinguished purely by the `length` convention at the
consumer, never by type.

**Consequence:** you **cannot** simply flip `i32_byte`'s element type to `i8` —
that would silently truncate every `Int32Array`/`Uint32Array` element to 8 bits
(MISCOMPILE). The optimization **requires disentangling** the byte-buffer
semantic from the 32-bit-element semantic into **two distinct vec keys**:

- **byte buffer** (ArrayBuffer / DataView) → a packed **`i8`** element vec
  (converge onto `i8_byte`, or introduce a dedicated `i8_buf` key).
- **Int32/Uint32 element storage** → a distinct **i32-element** key
  (e.g. rename to `i32_elem`) so it keeps full 32-bit slots.

This split is the bulk of the work and the main risk surface — every
`"i32_byte"` literal in the codebase must be audited and routed to the correct
one of the two new keys.

### 3. Blast radius — every consumer of `$__vec_i32_byte`

Files/functions that reference `i32_byte` (the byte-buffer ones must move to the
packed `i8` rep; the Int32/Uint32 ones must move to the new i32-element key):

**`src/codegen/dataview-native.ts`** — the core. All read/write helpers read
whole-byte slots and must switch `array.get` → `array.get_u` (and drop the now
redundant `& 0xff` masks, which stay correct but become no-ops):
- `i32ByteVec` (l.256), `getOrRegisterDvWindowType` (l.274, the `buf` field type),
  `recoverDvBacking` (l.308) — backing recovery + window struct.
- `emitDataViewAccessor` (l.422) and its byte helpers: `pushByte` (l.576,
  `array.get` → `array.get_u`), `emitReadBytes`/`emitReadI32`/`emitReadI64`
  (l.594/654/716, the multi-byte assemble across N packed elements),
  `buildIntoBranch` (l.682), `emitStoreByte`/`emitWriteBytes` (l.762/785, the
  multi-byte scatter; `array.set` on `i8` truncates so the masks are redundant).
- `emitArrayBufferSlice` (l.81).
- `emitDataViewToWriteScratch` (l.913) — the WASI `node:fs` write scratch copy
  (`array.get` → `array.get_u` at l.972).

**`src/codegen/index.ts`**:
- `TYPED_ARRAY_PACKED_STORAGE` / legacy table (l.205-217) — split keys.
- `__vec_get` (l.4853, 4890-4930), `__vec_pop` (l.5250-5288),
  `emitVecSetByteExport` (l.5332-5397) — the `i32_byte` arms move to `array.get_u`
  / packed `array.set`; the Int32/Uint32 element arm stays on the i32-element key.
- `emitDataViewByteExports` (l.5524-5654) — `__dv_byte_get` (`array.get` →
  `array.get_u`, l.5599) and `__dv_byte_set` (`array.set` truncates, l.5640).
  **JS-host interplay:** these exports let the JS runtime materialise a real
  `DataView` over the GC array; packing is transparent to the JS side because it
  only ever calls these accessors (it never reads the raw array), so the JS host
  path keeps working unchanged (see runtime.ts l.10129, l.12805).
- `getOrRegisterSubviewType` registration (l.7290-7300) — `subarray` views.

**`src/codegen/property-access.ts`** — `.byteLength`/`.length` (l.2844-2870),
`Uint8Array`/buffer-from-view materialisation (l.2930-3058, the
`ref.cast`-to-`i32_byte` and synthesized-buffer paths), the Int32/Uint32 element
read (l.6941, stays on i32-element key).

**`src/codegen/expressions/new-super.ts`** — `new ArrayBuffer(n)` (l.4431-4433),
`new Uint8Array(buffer)` / view-over-buffer copy
(`emitTypedArrayFromByteBuffer`, l.3389-3439, 4368-4433, 4899-4917). Note these
already **copy** bytes between buffer and typed-array storage rather than
aliasing, which limits the split's correctness surface.

**`src/codegen/object-runtime.ts`** — `NON_ARRAY_BYTE_VEC_ELEM_KINDS`
(l.7338) already lists both `i32_byte` and `i8_byte`; add any new key.

**`src/codegen/type-coercion.ts`** — the `i32_byte` skip in the array-coercion
path (l.1670-1686).

**`src/codegen/node-fs-api.ts`** — `elemKey` selection (l.118-121), DataView arg
resolution (l.767, 880).

**`src/codegen/expressions/calls.ts`** — DataView accessor dispatch + buffer
copy (l.9001-9029), typed-array storage selection (l.5338).

**`src/codegen/context/types.ts`** — `dvWindowTypeIdx` doc / `buf` field type
(l.1443-1450).

### 4. Risks

- **Canonicality / MISCOMPILE (the #2789 hazard):** `array-element-typing.ts`
  warns packing breaks soundness for element types where the f64 image of a
  packed value can differ from the original. **Bytes are the provably safe
  case:** every value stored is masked to `0..255` and read back zero-extended,
  so `array.get_u(i8) ∈ [0,255]` is bit-identical to what the i32 slot held.
  There is no `-0`, no fraction, no `>2^31` hazard — the canonical-i32 proof is
  trivially discharged for bytes. No new guards needed *for the byte path*. The
  guard discipline is entirely in **not** packing the Int32/Uint32 element path.
- **Signedness:** byte reads in the DataView accessors do their own
  sign-extension after assembling the i32 (`emitReadBytes`), so the backing read
  must be **unsigned** (`array.get_u`) regardless of `getInt8` vs `getUint8` —
  the accessor sign-extends the assembled value, not the slot. For the native
  `Int8Array`/`Uint8Array` views over the same buffer, `typedArrayPackedSignedness`
  already drives `get_s`/`get_u` correctly (unchanged).
- **Type-index registration + DCE remap:** this codebase has been bitten by
  type-index remapping during DCE (memory: `project_type_index_shift_and_deadelim`,
  `reference_subview_type_idx_stability`). The new packed-byte vec struct (and
  the renamed i32-element struct) must be **reserved up-front / registered
  late-once**, exactly as the existing pre-registered `externref`/`f64` vecs are
  (`registry/types.ts:139-143` `suppressVecUsageFlag`). Do **not** let the split
  introduce a struct that registers at a body-time index that DCE then remaps.
- **Validator support:** packed `i8`/`i16` arrays encode the element as an SLEB
  storage byte (`-0x8`/`-0x9`); only GC-aware validators accept them. This is
  already true for the shipping `i8_byte`/`i16_byte` typed arrays, so the
  toolchain (Binaryen wasm-opt, the runtime engines used in CI) already handles
  packed arrays — no new validator gap. Confirm the standalone floor harness
  engine is GC-packed-aware (it already runs the packed typed-array tests).
- **DataView arbitrary-offset multi-byte access — net-positive check:** a
  `getFloat64` now does 8× `array.get_u` + shift/or to assemble an i64 instead of
  8× `array.get` + mask (the assemble loop already does per-byte access — see
  `emitReadI64`/`buildIntoBranch`), so the **instruction count is essentially
  unchanged** (the only delta is `get_u` vs `get` + a dropped redundant mask).
  The memory win (4×) dominates; there is no extra get/shift cost introduced by
  packing because the accessors were **already** byte-at-a-time. This makes the
  tradeoff clearly net-positive for DataView, unlike a hypothetical whole-word
  representation.

### 5. Effort + phasing

- **Horizon: L** (single area — codegen — but wide blast radius and a
  representation-key split that touches ~9 files and the DCE/type-index
  discipline).
- **Phasing — recommended two PRs:**
  1. **PR-1 (the split, no rep change):** introduce the distinct i32-element key
     for `Int32Array`/`Uint32Array` (rename `i32_byte`→`i32_elem` for that use)
     while keeping ArrayBuffer/DataView on `i32_byte` (still i32 slots). This is
     a pure refactor with **no behavioural change** — easy to validate green —
     and it removes the overloading that blocks the rep change.
  2. **PR-2 (the packing):** flip the ArrayBuffer/DataView byte key to the packed
     `i8` element type (converge onto `i8_byte` or `i8_buf`), switch all byte
     reads to `array.get_u`, drop redundant masks. This is the part that delivers
     the 4× win and carries the real risk.
- Shipping in one PR is possible but inadvisable: the split + rep change in one
  diff makes a regression hard to bisect across the two orthogonal changes.

### 6. Verdict

**Feasible and worth it** — the 4× footprint reduction is large, the packed-i8
machinery already exists and is proven (#2593), and bytes are the provably safe
packing case (no canonicality hazard). The single real obstacle is the
**`i32_byte` overloading** (byte buffer vs Int32/Uint32 element storage), which
must be split into two keys first; that split is mechanical but wide. Estimated
**L**, best delivered as **2 PRs** (split, then pack).

**Broad-impact → MUST be validated via full CI / `merge_group`, never scoped.**
The representation change touches ArrayBuffer, DataView, every integer
TypedArray, the WASI `node:fs` write path, and the JS-host `__dv_byte_*` /
`__vec_*` exports. Scoped local checks cannot cover the standalone floor + the
host-marshalling boundary; the `merge_group` re-validation (test262 merge-shard
reports + standalone floor) is the only gate that exercises all consumers.

---

## Implementation Plan

### Root cause
`$__vec_i32_byte` (`struct { length: i32, data: array(mut i32) }`) stores one
full `i32` per byte for ArrayBuffer/DataView, a 4× blow-up. The same struct type
is reused for Int32/Uint32 element storage where 32-bit slots are correct, so the
element type cannot be flipped in place — the two uses must first be separated.

### Phase 1 — split the overloaded key (no representation change)

**File: `src/codegen/index.ts`**
- `TYPED_ARRAY_PACKED_STORAGE` (l.205-217) and the legacy map (l.210-211):
  route `Int32Array`/`Uint32Array` to a NEW key `i32_elem` (`{ kind: "i32" }`),
  leaving `i32_byte` exclusively for ArrayBuffer/DataView byte buffers.
- `__vec_get` (l.4890-4930), `__vec_pop` (l.5250-5288), `emitVecSetByteExport`
  (l.5389): add the `i32_elem` arm alongside `i32_byte` (both still plain
  `array.get`/`array.set` in this phase — identical codegen, just two keys).
- `getOrRegisterSubviewType` (l.7290-7300): register the `i32_elem` subview for
  Int32/Uint32 `subarray`.

**File: `src/codegen/property-access.ts`** — Int32/Uint32 element read
(l.6941-6951) and view materialisation (l.2930-3058): use `i32_elem`.

**File: `src/codegen/expressions/new-super.ts`** — `new Int32Array(...)` /
`new Uint32Array(...)` storage (l.3389-3439, 4368-4433): use `i32_elem`;
`new ArrayBuffer(n)` (l.4431-4433) stays `i32_byte`.

**File: `src/codegen/object-runtime.ts`** — verify whether `i32_elem` belongs in
`NON_ARRAY_BYTE_VEC_ELEM_KINDS` (l.7338). It should NOT — Int32Array IS
array-like and must keep array treatment; leave `i32_elem` out.

- **Type-index discipline:** pre-reserve the `i32_elem` struct idx the same way
  `externref`/`f64` are pre-registered (`registry/types.ts` `suppressVecUsageFlag`)
  to avoid a DCE remap (memory: `project_type_index_shift_and_deadelim`).
- **Gate:** Phase 1 must be byte-for-byte behaviour-preserving — full CI green
  with no test262 / standalone-floor delta.

### Phase 2 — pack the byte buffer as `array(mut i8)`

**File: `src/codegen/registry/types.ts`** — give `i32_byte` (now byte-only) the
packed element type `{ kind: "i8" }`. Either change the element type behind the
`i32_byte` key, or rename to `i8_buf`/converge onto the existing `i8_byte`. If
converging onto `i8_byte`, ensure ArrayBuffer/DataView and native Uint8Array
sharing the same vec type is acceptable to every `ref.test`-based dispatch
(`__vec_get`, `recoverDvBacking`) — it should be, since both are byte buffers.

**File: `src/codegen/dataview-native.ts`** — switch every byte read from
`array.get` to `array.get_u`:
- `pushByte` (l.583), `buildIntoBranch` byteAt (l.697), `emitReadI64` byteAt
  (l.735), `emitDataViewToWriteScratch` loop (l.972).
- `emitStoreByte` (l.777): `array.set` on an `i8` array auto-truncates; the
  caller's `& 0xff` masks become redundant (keep or drop — both correct).
- `getOrRegisterDvWindowType` `buf` field (l.282) + `i32ByteVec` (l.256-258):
  the array type idx now refers to the packed array.

**File: `src/codegen/index.ts`** — `emitDataViewByteExports`: `__dv_byte_get`
`array.get` → `array.get_u` (l.5599); `__dv_byte_set` `array.set` unchanged
(truncates). `__vec_get`/`__vec_pop`/`emitVecSetByteExport` `i32_byte` arms join
the `array.get_u` branch (the `i8_byte` arm already does this — converge).

**File: `src/codegen/node-fs-api.ts`** — `elemKey`/element-type selection
(l.118-121): `i32_byte` element type becomes `{ kind: "i8" }`.

**File: `src/codegen/type-coercion.ts`** — `i32_byte` skip (l.1670-1686) still
applies (it's keyed by typeIdx, not element kind) — verify unchanged.

### Wasm IR pattern (byte read, after packing)
```wasm
;; pushByte(arr, off, k): read one byte, zero-extended
local.get $arr            ;; (ref $__arr_i8_byte)
local.get $off
i32.const k
i32.add
array.get_u $__arr_i8_byte ;; was: array.get $__arr_i32_byte + (i32.const 0xff; i32.and)
;; result already in [0,255] — redundant mask may be dropped
```

### Edge cases
- `getInt8`/`getUint8`: backing read is ALWAYS `array.get_u`; the DataView
  accessor sign-extends the assembled value itself (`emitReadBytes` l.605-614),
  independent of the slot read.
- Multi-byte `getFloat64`/`getUint32` across packed elements: the assemble loop
  is unchanged (it was already byte-at-a-time); only the per-byte opcode changes.
- `Int32Array`/`Uint32Array`: must remain on the i32-element key (Phase 1) — a
  packed i8 here truncates to 8 bits (MISCOMPILE). This is the soundness pivot.
- JS-host mode: the JS runtime only calls `__dv_byte_get`/`__dv_byte_set`, never
  reads the raw array, so packing is transparent to the host path.
- `new Int32Array(arrayBuffer)`: already copies bytes into element storage
  (`emitTypedArrayFromByteBuffer`) rather than aliasing — the byte→element
  reinterpret copy must read the (now packed-i8) source via `array.get_u`.

### Test files to verify (full CI / merge_group)
- `test/built-ins/DataView/**` — get/set across all widths + endianness.
- `test/built-ins/ArrayBuffer/**` — slice, byteLength.
- `test/built-ins/TypedArray*/**` and `test/built-ins/Int32Array`/`Uint32Array`
  — confirm 32-bit element fidelity survives the key split (Phase 1 regression
  guard).
- Standalone floor: `node:fs` writeSync(fd, DataView/Uint8Array), Native-Messaging
  frame round-trip (the #2832 64 MiB path) — confirm the 4× memory reduction and
  no value corruption.

---

## PR-1 implementation notes (the split — NO rep change)

**Status: PR-1 of 2 landed via this PR.** This PR does ONLY Phase 1 (split the
overloaded key). PR-2 does the i8 packing and closes the issue.

### What changed (the split design used)

The `i32_byte` vec key was overloaded for two semantically distinct uses
(byte buffer vs Int32/Uint32 element storage). I split off a **new `i32_elem`
key** for the element-storage use and left `i32_byte` exclusively the
ArrayBuffer/DataView byte buffer. Both still resolve to
`struct { length: i32, data: array(mut i32) }` — **pure refactor, no rep change**.

The split pivots on **one source-of-truth edit** plus a handful of generic-helper
arms that must treat the new key identically to how `i32_byte` was treated
pre-split:

1. **`src/codegen/index.ts` `TYPED_ARRAY_PACKED_STORAGE`** — `Int32Array`/
   `Uint32Array` map to key `i32_elem` (was `i32_byte`). This is the **single
   source of truth**: every typed-array type resolution (`resolveWasmType`,
   the IR `resolvePositionType`), every constructor (`new Int32Array(...)`,
   `Int32Array.of/from`), `byteLength`, and view materialisation routes through
   `typedArrayVecStorage`, so this one edit re-routes them all automatically.
   The ArrayBuffer/DataView byte-buffer sites hard-code `i32_byte` and are
   untouched.
2. **`__vec_get` (skip-check + box arm)** and **`emitVecSetByteExport`** — added
   `i32_elem` alongside `i32_byte` so the generic dynamic read/byte-write of an
   `i32_elem` vec is **byte-for-byte identical** to the pre-split `i32_byte`
   behaviour (plain `array.get`, unsigned i32→f64 box; direct `array.set`).
   `__vec_pop` needed no change — `i32_elem` falls into its default (signed,
   plain `array.get`) arm exactly as `i32_byte` did there.
3. **`reserveTypedArraySubviewTypes`** — the Int32/Uint32 `subarray` subview is
   now keyed `i32_elem` (1:1 swap of the old `i32_byte` subview). An
   `Int32Array.subarray()` receiver is `__vec_i32_elem`, so it resolves the
   subview by stripping the struct-name prefix → `i32_elem`, which MUST hit a
   PRE-RESERVED idx-stable slot (the #2357 hoist/emit desync hazard). The byte
   buffer has no `subarray` view and resolves directly to its vec, so it does
   NOT need an eager slot and registers lazily as before.
4. **`object-runtime.ts` `NON_ARRAY_BYTE_VEC_ELEM_KINDS`** — added `i32_elem`.
   This set drives `Array.isArray` (§7.2.2) ONLY. Pre-split, Int32/Uint32 were
   `i32_byte` (already in the set → `Array.isArray === false`, spec-correct: a
   TypedArray is not an Array). Adding `i32_elem` preserves that exactly;
   omitting it would have regressed `Array.isArray(new Int32Array(1))` to `true`.
   **(The architect's Phase-1 note said "leave i32_elem out" — that reasoning
   conflated general array-likeness with `IsArray`; this set is IsArray-only and
   does not affect element access / `.length` / iteration.)**

### Why this is safe (no behaviour change)

- `i32_elem` only ever materialises in **standalone/WASI** mode (`typedArrayVecStorage`
  returns the packed keys only there; JS-host keeps Int32Array on `f64`), which
  bounds the blast radius and leaves JS-host paths inert.
- The generic helpers read the element kind from the **type table**
  (`getVecInfo`/`getArrTypeIdxFromVec`), not the key string, so `i32_elem`
  (i32 element) is handled identically to `i32_byte` (i32 element) wherever
  element-kind drives codegen.
- `emitTypedArrayFromByteBuffer` (`new Int32Array(arrayBuffer)`) already takes
  separate src/dst vec params and registers the `i32_byte` source independently —
  it copies `i32_byte` → `i32_elem` correctly (both i32-element; logic unchanged).

### Verification

- `tsc --noEmit` clean.
- DataView/ArrayBuffer/typed-array suites green (`issue-38`, `issue-2199`,
  `issue-2199b`, `issue-2639`, `issue-1654`, `issue-2593`, `issue-2648`,
  `issue-1670`, `issue-1787`): 40+ tests pass.
- Standalone end-to-end probe: Int32/Uint32 32-bit element fidelity, `subarray`
  windowing, DataView byte round-trip, and Int32Array+DataView coexistence all
  match the base commit exactly.
- Pre-existing failures confirmed identical on the base commit (so NOT introduced
  here): the container's default string backend emits `string_constants` imports
  that some JS-host test harnesses don't stub; a base-commit
  `Uint8Array.subarray` WASI write failure; and a Uint32 write-saturation
  limitation (#2593-deferred wrapping).

### Out-of-scope pre-existing bug found (flag, NOT fixed here)

The Native-Messaging `nm_js2wasm_node_process` scale-test fails to compile on
**origin/main** (independent of this PR): `__vec_from_extern_<N>` validation error
`expected i32, found externref`. Root cause: `buildVecFromExternref`'s
`buildElemCoerce` (`src/codegen/type-coercion.ts`) handles `f64`/`i32`/`externref`/
`ref` element kinds but **not `i8`/`i16`**, so the materializer for a `Uint8Array`
(`i8_byte`) vec field pushes an externref into an `i8` array. node_fs (the other
byte-buffer NM host) passes. This is a separate latent issue (the NM scale-test is
not a CI gate) and is unrelated to the #2835 key split — worth its own issue.

---

## PR-2 implementation notes (the packing — the 4× win, closes #2835)

**Status: PR-2 of 2. Closes #2835.** PR-1 split the overloaded key so the
ArrayBuffer/DataView byte buffer (`i32_byte`) is disentangled from Int32/Uint32
element storage (`i32_elem`). This PR flips the byte buffer to a packed
`array(mut i8)` (1 byte/element), delivering the 4× GC-footprint cut.

### Representation decision — keep the `i32_byte` KEY, change its element type

I did **not** converge the byte buffer onto the existing `i8_byte` key. Instead
the `i32_byte` key/struct (`$__vec_i32_byte`) is **retained as a distinct type**
but its data array element type changed `i32 → i8`. Rationale:

- `recoverDvBacking`, `getOrRegisterDvWindowType` (`buf` field), `emitArrayBufferSlice`,
  `emitTypedArrayFromByteBuffer`, the `.buffer` synth, `__dv_byte_*` exports and
  the `node:fs` write helpers all `ref.test`/`ref.cast` to the **`i32_byte` vec
  type** to recover a DataView/ArrayBuffer backing. Native `Uint8Array` is a
  **separate** value that uses `i8_byte`. Converging the two onto one struct
  would make a `Uint8Array` and an ArrayBuffer backing structurally
  indistinguishable to every `ref.test`-based dispatch (e.g. a windowed DataView
  over a Uint8Array vs over an ArrayBuffer) — a needless ambiguity. Keeping
  `i32_byte` distinct preserves the existing dispatch exactly; only the per-byte
  storage shrinks. The two i8-element arrays (`__arr_i32_byte`, `__arr_i8_byte`)
  are deduped under distinct cache keys, so they stay separate types.
- **Single consistency invariant:** `getOrRegisterVecType` caches by key, so the
  FIRST registration's element-type override wins. Every `i32_byte` registration
  site (dataview-native, property-access, new-super ArrayBuffer/DataView ctors +
  `emitTypedArrayFromByteBuffer`, node-fs-api) was therefore switched to
  `{ kind: "i8" }` in lockstep — a mismatch would have desynced the array
  element type from the read opcode.

### Reads → `array.get_u`, writes unchanged (`array.set` truncates)

`array.get` on a packed array is **invalid Wasm**, so every hardcoded byte READ
on the `i32_byte` backing became `array.get_u` (unsigned, zero-extended to i32 —
this is the validator's safety net: a missed site fails module validation, never
silently miscompiles):

- `dataview-native.ts`: `pushByte`, `buildIntoBranch` byteAt, `emitReadI64`
  byteAt, `emitArrayBufferSlice` copy, `emitDataViewToWriteScratch`.
- `index.ts`: `__vec_get` (i32_byte joins the `array.get_u` branch), `__vec_pop`
  (i32_byte joins `isPackedByte`), `__dv_byte_get`, `ensureWasiWriteArrayBufferHelper`.
- `new-super.ts`: `emitTypedArrayFromByteBuffer` source read.

WRITES (`emitStoreByte`, `__dv_byte_set`, `emitVecSetByteExport`, the slice/synth
`array.set`/`array.new`) need **no change** — `array.set`/`array.new` on a packed
i8 array auto-truncate the i32 to the low byte, exactly the `& 0xff` semantics the
byte writers already enforced (the masks are now redundant but kept defensively).

### Why this is byte-exact / soundness

- **Bytes are the provably-safe packing case** (per §4 of the feasibility): every
  value stored is `0..255` and read back zero-extended, so `array.get_u(i8) ∈
  [0,255]` is bit-identical to the value the old i32 slot held. No `-0`, no
  fraction, no `>2^31` hazard — the canonical-i32 proof is trivial.
- **Signedness:** the DataView accessors sign-extend the *assembled* value
  (`getInt8`/`getInt16`/…) themselves, so the backing read is ALWAYS unsigned
  (`array.get_u`) regardless of the accessor's signedness — unchanged contract.
- Most typed-array element reads (`property-access.ts`, `calls.ts` TA-from-TA
  copy, the `array.get_u`-for-i8 helper in `new-super.ts`) already derive the
  opcode from `arrDef.element.kind`, so they handle the i8 byte buffer correctly
  with no edit.
- `i32_elem` (Int32/Uint32 element storage) is deliberately **untouched** — it
  stays full 32-bit (plain `array.get`, signed/unsigned box). Packing it would
  truncate every 32-bit element (the MISCOMPILE the PR-1 split exists to prevent).

### Type-index / DCE discipline

The `i32_byte` vec still registers **lazily** (the byte buffer has no `subarray`
view, so no eager pre-reservation slot is needed — unchanged from PR-1). Changing
only the element type does not alter *when* it registers, so no new
type-index/DCE-remap hazard is introduced
(`project_type_index_shift_and_deadelim`, `reference_subview_type_idx_stability`).

### Verification

- `tsc --noEmit` clean.
- DataView / ArrayBuffer / TypedArray / Uint8Array suites green, byte-identical:
  `issue-1654` (5), `issue-2199` (bounds), `issue-2199b` (setter order),
  `issue-2593` (typed-array int-width), `issue-2639` (node:fs writeSync
  string+DataView, incl. windowed byteOffset/byteLength), `issue-2648`,
  `issue-1670`, `issue-1787` (packed-typedarray-semantics), `issue-2379` — all pass.
- **NM scale-test** (`node examples/native-messaging/scale-test.mjs`,
  `NM_SCALE_SIZES_MIB="1 64 128 256"`): all four hosts (`node_process`, `deno`,
  `wasi_p1`, `node_fs`) round-trip byte-exact at every size up to **256 MiB**
  under real wasmtime 46. A 256 MiB ArrayBuffer now materialises as a 256 MiB GC
  array instead of ~1 GiB (4× cut). `nm_js2wasm_node_process` — which PR-1 noted
  failed on origin/main before #2839 — now passes (the #2839 `buildElemCoerce`
  i8 arm landed; this PR keeps the byte buffer consistent with it).
- Pre-existing failures confirmed IDENTICAL on base origin/main (NOT introduced
  here): `arraybuffer-dataview.test.ts` (6 — the JS-host harness doesn't stub the
  default string backend's `string_constants` import) and the one
  `issue-1655` Uint8Array.**subarray** WASI-write `illegal cast` (base-commit
  bug flagged in PR-1 notes). Verified by running both files on a detached
  origin/main worktree: same 7-failed/7-passed split with and without this PR.

### Validator note

Packed `i8` arrays encode the element as an SLEB storage byte (`-0x8`), a
GC-aware-validator-only encoding (like the i16 string `-0x9`). This is already
true for the shipping `i8_byte`/`i16_byte` typed arrays, so wasmtime / wasm-tools
/ Binaryen already accept it — confirmed by the 256 MiB real-wasmtime scale-test.
