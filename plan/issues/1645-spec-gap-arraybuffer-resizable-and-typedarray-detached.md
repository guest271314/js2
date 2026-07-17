---
id: 1645
title: "spec gap: ArrayBuffer resizable + TypedArray detached-buffer guards (100 + 39 test262 fails)"
status: ready
created: 2026-05-08
updated: 2026-06-17
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: typedarray
goal: spec-completeness
sprint: Backlog
renumbered_from: 1351
parent: 1328
---
# #1351 — ArrayBuffer.resize / detached-buffer guards on TypedArray methods

## Problem

`built-ins/ArrayBuffer`: **87 / 196 pass (44.4%) — 100 fails (44 wasm_compile, 36 assertion_fail,
9 other, 5 null_deref, 1 type_error)**.
`built-ins/DataView`: **410 / 561 pass (73.1%) — 26 runtime_error among 112 fails**.
`built-ins/Uint8Array`: **31 / 68 pass (45.6%) — 37 fails**.

Spec §25.1 (ArrayBuffer): ArrayBuffer can be resizable (constructor accepts `{maxByteLength}`) or
fixed-length. Detached buffers throw TypeError on every read/write/access.

Spec §23.2 (TypedArray): every prototype method must check IsDetachedBuffer at the start, throw
TypeError if detached. ArrayBuffer.transfer detaches the source.

The 44 wasm_compile errors in ArrayBuffer suggest the ResizableArrayBuffer constructor signature
isn't recognized — the typed-codegen path gets a wrong arity.

## Acceptance criteria

1. `built-ins/ArrayBuffer/prototype/resize/length.js` passes.
2. `built-ins/ArrayBuffer/transfer/detaches-source-buffer.js` passes.
3. `built-ins/TypedArray/prototype/copyWithin/detached-buffer-throws.js` passes.
4. `built-ins/DataView/prototype/getInt32/detached-buffer-throws.js` passes.
5. Pass-rate for `built-ins/ArrayBuffer` rises from 44% to ≥75%.

## Files to modify

- `src/runtime.ts` — `__arraybuffer_*` host imports
- `src/codegen/registry/typedarray.ts` — detached-buffer guards on every prototype method

## Implementation Plan

### Root cause

ResizableArrayBuffer is newer (ES2024); our codegen registry doesn't have an overload for the
options-object constructor `new ArrayBuffer(byteLength, {maxByteLength})`. Type-inference picks
the wrong overload and emits a wasm_compile-failing call.

Detached-buffer guards: each TypedArray method needs a prologue:
```
if (IsDetachedBuffer(this[[ViewedArrayBuffer]])) throw TypeError
```
We've inlined the methods without this guard.

### Approach

1. **Resizable**: add an options-object constructor variant. Store `maxByteLength` in the
   ArrayBuffer struct; `.resize(newLength)` updates `byteLength` if `<= maxByteLength`, throws
   RangeError otherwise.
2. **transfer**: implement by allocating a new buffer, copying data, marking source detached.
3. **Detached guards**: extend the codegen registry so every TypedArray method emits a detached
   check at entry. Add `IsDetachedBuffer` host import that returns 1/0.

### Edge cases

- `transfer()` with no argument → use source's byteLength.
- `transfer(newLen)` where newLen > source: zero-pad.
- Detached check must run even for length-0 access (e.g. `view.getInt8(0)` on a 0-length detached buffer).
- DataView: detached check separate from ArrayBuffer detached.

### Test262 sample

- `test262/test/built-ins/ArrayBuffer/prototype/resize/length.js`
- `test262/test/built-ins/ArrayBuffer/transfer/detaches-source-buffer.js`
- `test262/test/built-ins/TypedArray/prototype/copyWithin/detached-buffer-throws.js`

## Remaining work (2026-06-17, PO reconcile — NOT started)

The s63 reconciler flagged this issue because merged PR #1532
(`chore(#2148): drain in-review orphan pool — reconcile #1326, #1645`) carries
`#1645` in its title. That PR is **docs-only** — it re-classified this issue's
status during the orphan-pool sweep and explicitly recorded "No implementation
exists (spec-gap)", setting it to `ready` / `sprint: Backlog`. The other three
merged PRs that name #1645 (#702/#666/#800) are likewise all `docs(...)`
escalation/dedup notes, not code.

**No code has landed against any acceptance criterion.** Resizable ArrayBuffer
(`{maxByteLength}` constructor + `.resize`), `ArrayBuffer.transfer`, and the
TypedArray/DataView detached-buffer guards are all unimplemented; the
`built-ins/ArrayBuffer` pass-rate target (44% → ≥75%) is unmet. Status correctly
stays `ready` / `sprint: Backlog` — the full Implementation Plan above is the work
to be done.

## Slicing (dev-g investigation, 2026-07-17)

Measured against fresh `upstream/main`: substantial resize/detach machinery
already exists (#3054-C / #3058 `.resize`, #3097 host-AB marshal bridge), but
**`ArrayBuffer.prototype.transfer` has no dispatch arm** — `ab.transfer()`
throws `TypeError: transfer is not a function` from the `__extern_method_call`
fall-through (`src/runtime.ts` ~L10668, right after the `resize` arm at L10569).

I prototyped a runtime `transfer` / `transferToFixedLength` arm that allocates a
host `ArrayBuffer` with the copied bytes and marks the source detached
(`_detachedBuffers.add`). It compiles and `dest.byteLength` reads correctly, but
it **fails the target test262 asserts** (`prototype/transfer/from-fixed-to-same.js`
et al.) for two structural reasons, both requiring **codegen** work, not
runtime-only:

1. **Source detach is invisible to compiled native reads.** The test asserts
   `source.byteLength === 0` after transfer. A statically-typed `ArrayBuffer`
   receiver lowers `.byteLength` to a direct `array.len` on the backing vec
   struct, which **bypasses** the host `_detachedBuffers` WeakSet mark — so it
   returns the *old* length (measured: 8, not 0). Detaching a compiled AB struct
   needs a **native detach primitive** (zero the vec length field + a
   struct-readable detached flag), so `array.len` / the detached guards observe
   it. The same gap breaks `source.slice()`-throws-after-detach.
2. **`new Uint8Array(dest)` over a host-AB externref returns NaN.** transfer must
   return a value the *compiled* code can view; the compiled `TypedArray`
   constructor over a host `ArrayBuffer` externref does not read its bytes
   (measured: `destArray[0]` → NaN). Either the ctor must accept a host AB, or
   transfer must return a **compiled vec struct** (which needs a host-callable
   struct allocator — none is exported today; only in-place `__rab_resize`).

### Proposed 3-way split

- **(a) native AB detach primitive + `transfer`/`transferToFixedLength`** —
  senior-dev, **L**. Add a codegen detach op on the vec struct (length→0 +
  detached flag readable by `array.len` sites and the detached guards) and a
  host-callable byte-vec allocator so `transfer` can return a live compiled
  buffer; wire the two dispatch arms. Unblocks the `transfer` cluster
  (~48 tests) and acceptance criterion #2.
- **(b) detached-buffer method guards** on TypedArray/DataView prototype
  methods — **M**. `$262.detachArrayBuffer` uses the host WeakSet path (already
  observable), so these guards (`copyWithin`/`getInt32`/… throw TypeError when
  detached) are runtime-tractable independent of (a). Acceptance criteria #3/#4.
- **(c) resizable prototype-introspection / descriptor tests** — **hard**.
  `resize.length === 1`, `transfer.name`, `dest.resizable`/`maxByteLength`
  descriptor shape, etc. require real function-object / accessor introspection
  on builtin prototypes, which the compilation model does not currently model.

Leave #1645 `ready` as the umbrella; (a)/(b)/(c) can be filed as sub-issues when
scheduled.
