---
id: 3054
title: "Resizable ArrayBuffer + dynamic `new <ctorVar>(rab)` — the ~180 codegen gap under #1524"
status: ready
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
