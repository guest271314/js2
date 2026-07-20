---
id: 3274
title: "Decompose ensureObjectRuntime into cohesive sibling modules (WAVE-B, slices 1-3)"
status: done
created: 2026-07-14
updated: 2026-07-19
completed: 2026-07-14
priority: high
feasibility: hard
horizon: l
reasoning_effort: max
task_type: refactor
area: codegen
goal: maintainability
sprint: 72
subtask_of: 3182
assignee: ttraenkler/Dev-WaveB-ObjRuntime
related: [3182, 742, 808]
loc-budget-allow:
  - src/codegen/object-runtime-descriptors.ts
coercion-sites-allow:
  - src/codegen/object-runtime-descriptors.ts
---

# #3274 — Decompose `ensureObjectRuntime` (WAVE-B slice 1: descriptor + integrity)

## Problem

`ensureObjectRuntime` in `src/codegen/object-runtime.ts` is a ~7,378-LOC single
function (the file's remaining core after the wave-1 Proxy split; file ~10,149
LOC). It sequentially BUILDS the whole standalone-native open-object runtime —
dozens of `registerNative(...)` helper-build blocks that all share a captured
scope (the `registerNative` minter, the object-runtime type indices / ValType
aliases, dependency func indices, and the `$PropEntry.$flags` / `$Object.flags`
bit constants). This is a WAVE-B (mega-function decomposition) target under the
code-bloat elimination epic #3182.

## Approach — byte-identical intra-function decomposition

Extract cohesive groups of helper-builds into named helper functions in NEW
sibling modules, replacing each inline block with a single call that threads the
captured scope through a typed state bundle. The gate is
`scripts/prove-emit-identity.mjs`: baseline BEFORE, `check` AFTER each slice MUST
print `IDENTICAL` (39/39 gc/standalone/wasi). `tsc --noEmit` stays 0.

Because the relocation is verbatim (the moved code is character-for-character
identical; the only additions are a destructuring preamble in the new function
and a state-object literal at the call site), the `registerNative` call ORDER —
and therefore the minted func-index sequence and the emitted Wasm — is preserved
exactly. This is an intra-function relocation, so the oracle-ratchet is net-zero
(#3070, change-scoped/net-per-field).

## Slice 1 (this issue) — descriptor + integrity group

Extracted the `__defineProperty_value` … integrity-SET-path block (~2,464 LOC,
former lines 5052–7515) VERBATIM into `src/codegen/object-runtime-descriptors.ts`
as `buildObjectDescriptorHelpers(ctx, state)`. Helpers relocated:

- `__defineProperty_value` / `__defineProperty_accessor` (define one property)
- `__defineProperties` (plural define)
- `__obj_define_from_desc` (dynamic single-descriptor apply)
- `__getOwnPropertyDescriptor` (descriptor read-back)
- `__create_descriptor` / `__create_accessor_descriptor` (descriptor objects)
- `__getOwnPropertyNames` / `__getOwnPropertySymbols` (own-key enumeration)
- `__object_getOwnPropertyDescriptors` / `__object_fromEntries`
- `__object_isFrozen` / `__object_isSealed` / `__object_isExtensible` (integrity predicates)
- `__object_preventExtensions` / `__object_seal` / `__object_freeze` (integrity set path)

`ensureObjectRuntime` shrinks from ~7,378 → ~4,950 LOC; `object-runtime.ts` from
10,149 → 7,721 LOC.

### Why the state bundle (implementation note)

The block reads a fixed set of values from the enclosing scope. Rather than
re-derive them (which would risk drifting the `registerNative` minting order),
they are threaded through `ObjectDescriptorHelperState` and destructured at the
top of the extracted function, so the moved body is textually unchanged:

- **The `registerNative` closure itself** (captures `ctx`) — passing the SAME
  closure object preserves func-index minting order.
- **Type indices**: `anyStrTypeIdx`, `nativeStrTypeIdx`, `propEntryTypeIdx`,
  `propMapTypeIdx`, `objectTypeIdx`, plus `symbolKeysEnabled`.
- **ValType aliases**: `objRefNull`, `propMapRef`, `entryRefNull`.
- **Dependency func indices** (already registered earlier in the pass):
  `strFlattenIdx`, `strEqualsIdx`, `objFindIdx`, `objInsertIdx`, `objGrowIdx`,
  `objVecNewIdx`, `objVecPushIdx`, `objIndexOfKeyIdx`, `objOrderedIdx`,
  `objOrderedAllIdx`, `externSetIdx`, plus optional `bfnGopdIdx` /
  `bfnPushOwnNamesIdx`.
- **Shared bit constants**: `NONE_HEAP`, `FLAG_WRITABLE`, `FLAG_ENUMERABLE`,
  `FLAG_CONFIGURABLE`, `FLAG_ACCESSOR`, `OBJ_FLAG_NONEXTENSIBLE`,
  `OBJ_FLAG_SEALED`, `OBJ_FLAG_FROZEN`, `WRAPPER_PRIMITIVE_KEY`.

`externGetIdx` is NOT captured — it is (re)declared block-locally inside the
`__defineProperty_accessor` and `__obj_define_from_desc` blocks, so it stays
self-contained. `emitIntegrityPredicate` / `emitSetFlags` are defined AND used
entirely within the extracted region, so they move with it. The constants are
passed via state (not imported) to avoid a new `object-runtime ↔ descriptors`
import cycle. Cross-module utility functions (`addStringConstantGlobal`,
`emitSelfHostedFunc`, `stringConstantExternrefInstrs`, `nativeStringLiteralInstrs`,
`undefinedExternInstrs`, `undefinedSingletonActive`, `emitWasiErrorConstructor`,
`ensureExnTag`, `addUnionImportsViaRegistry`, `SELF_HOSTED_OBJECT_RUNTIME`) are
imported directly from their original source modules.

## Slice 2 — enumeration / array-like / object-static group

Extracted the `__object_keys` … `__object_is` block (~1,137 LOC) VERBATIM into
`src/codegen/object-runtime-enumeration.ts` as `buildObjectEnumerationHelpers`.
Helpers relocated: `__object_keys` / `__object_keys_forin`, `__extern_length` /
`__extern_get_idx` / `__extern_has_idx`, `__object_values` / `__object_entries`,
`__object_assign`, `__object_is`.

`ensureObjectRuntime` shrinks a further ~1,137 LOC (after slice 1, now ~3,813).
`object-runtime.ts`: 7,720 → 6,607 LOC.

Notes: `externSetIdx` was the one function-scope `const` inside the region also
read by the (later) descriptor call, so it is re-derived
(`ctx.funcMap.get("__extern_set")!`) immediately before that call — byte-neutral.
`buildExternGetIdxBody` (a module-local helper the `__extern_get_idx` block
calls) is now `export`ed and imported by the sibling (a benign function-decl
cycle, used only at call time). `externGetIdx`/`externHasIdx` inside the region
are property-keys / block-locals, not captures. Byte-identity `check` =
`IDENTICAL` (39/39); `tsc --noEmit` = 0; `tests/issue-3274-slice2.test.ts` (4)
green (`__object_is` SameValue NaN/-0 edges + `__extern_length`, zero host
imports).

## Slice 3 — prototype-chain group

Extracted the prototype-chain block (~320 LOC) VERBATIM into
`src/codegen/object-runtime-prototype.ts` as `buildObjectPrototypeHelpers`.
Helpers relocated: `__getPrototypeOf`, `__object_create`,
`__object_setPrototypeOf`, `__isPrototypeOf`.

Cleanest slice yet — only 6 captures (`registerNative`, `propEntryTypeIdx`,
`propMapTypeIdx`, `objectTypeIdx`, `objRefNull`, `propMapRef`) + 2 consts
(`INITIAL_CAP`, `OBJ_FLAG_NONEXTENSIBLE`) via state, no cross-module imports, no
downstream-const entanglement. `object-runtime.ts`: 6,607 → 6,299 LOC;
`ensureObjectRuntime` now ~3,493. Byte-identity `check` = `IDENTICAL` (39/39);
`tsc --noEmit` = 0; `tests/issue-3274-slice3.test.ts` (3) green
(`Object.create(null)` + `getPrototypeOf` exercised natively, zero host imports).

## Deferred — entangled core (future fresh-budget slice)

Slices 1-3 extracted the three cohesive, cleanly-liftable groups
(descriptor/integrity, enumeration/array-like/object-static, prototype-chain),
taking `ensureObjectRuntime` from ~7,378 → ~3,493 LOC (~53%). The remaining
~3,493-LOC core is the **entangled hash-map + boxing substrate**:
`__obj_hash`, `__key_equals`, `__new_plain_object`, `__obj_find`, `__extern_get`,
`__obj_insert`, `__obj_grow`, `__extern_set`, `__reflect_set`, `__delete_property`,
`__new_Number/String/Boolean`, `__objvec_new/push`, `hasOwn`,
`__propertyIsEnumerable`, `__extern_has`, `__to_primitive`, `__extern_toString`,
`__obj_index_of_key`, the `__obj_ordered*` builders, `__extern_is_undefined`,
`__extern_method_call`, plus the `ensureProxyRuntime` tail.

This core is NOT a quick byte-identical lift: it *defines* the cross-cutting
closures the whole function shares — `emitClassifyKey`, `emitKeyMatch`,
`emitWrapperBuildTail`, `emitHasOwn`, `withKeyCoercion` — and threads forward
references (`tpkBodyRef` splice, `__to_property_key`/`__extern_toString` mutual
dependency). Extracting it byte-identically means also relocating those closures
and their forward-splice machinery, which is a deliberate design task warranting
its own architect pass and a fresh budget window. Tracked as a follow-up under
epic #3182; the three sibling modules created here are the seam it will build on.

## Acceptance criteria

- `scripts/prove-emit-identity.mjs check` → `IDENTICAL` (39/39). ✓
- `tsc --noEmit` → 0 errors. ✓
- `tests/issue-3274.test.ts` — descriptor/integrity helpers reachable and correct
  under `--target standalone` with zero host imports. ✓
- No behavioural change (pure relocation).

## Test Results

`tests/issue-3274.test.ts` (4 tests, all pass): `__defineProperty_value`,
`__defineProperty_accessor`, and `__getOwnPropertyDescriptor` (writable flag +
value read-back) exercised end-to-end in standalone with `env` imports empty.
Byte-identity `check` prints `IDENTICAL` across all 39 (file,target) emits.
