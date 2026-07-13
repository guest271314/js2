---
id: 3116
title: "Array exotic [[DefineOwnProperty]]: defineProperty(ies) element/length writes invisible to vec reads (§10.4.2 unimplemented on the runtime lanes)"
status: done
sprint: 71
created: 2026-07-09
completed: 2026-07-09
updated: 2026-07-13
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: runtime
language_feature: object-defineproperty, array-exotic
es_edition: 5
goal: spec-completeness
parent: 3022
related: [3022, 3043, 2186, 1629, 2668]
assignee: ttraenkler/fable-3022
test262_category: built-ins/Object/defineProperty, built-ins/Object/defineProperties
---

# #3116 — Array exotic [[DefineOwnProperty]]: vec write-back + ArraySetLength

Cause-scoped senior cluster from the #3022 umbrella ("array exotic
`[[DefineOwnProperty]]`", predicted ~83 fails; measured surface substantially
larger — ~236 of the 570 remaining `definePropert{y,ies}` fails have an Array
receiver).

## Root cause (verified empirically, 2026-07-09)

Split-brain read/write paths for compiled arrays in JS-host mode:

- `Object.defineProperty(arr, "0", {value: v})` (and the plural
  `defineProperties`) reaches the runtime with the **raw WasmGC vec struct**;
  native `Object.defineProperty` throws the "opaque" TypeError, and the generic
  opaque-struct arm stored the value **only in the host-side sidecar**
  (`_wasmStructProps` / `_wasmPropDescs`).
- Element and `length` **reads** compile to direct vec accesses (`struct.get`
  on the length field, `array.get` / `__vec_get` on elements) — they **never
  consult the sidecar**. So every define was invisible to every read
  (`15.2.3.6-4-214`: define throws correctly but `arrObj["0"] !== 101`).
- §10.4.2.1 **ArraySetLength** did not exist on the runtime lanes at all: no
  RangeError validation (`{length: {value: -1}}`), no shrink honoring
  non-configurable elements, no non-writable-length tracking. (The static
  singular `maybeEmitVecLengthDefine` inline path covers only the
  statically-typed singular shape.)
- In-bounds elements had **no synthesized existing descriptor**, so
  `_validatePropertyDescriptor` treated every element redefine as a _first
  definition_ — the §10.1.6.3 rejection matrix (SameValue on non-writable,
  configurable/enumerable toggles) never fired for array indices.

Two adjacent codegen bugs found by the same probe series:

1. **`get: null` / `set: null` / `get: undefined` dropped at compile time**
   (`15.2.3.7-5-b-218`): the plural static decomposition
   (`isStaticDescWellFormed`) classified them as "no accessor" and lowered
   `{get: null}` to `__defineProperty_value(obj, k, null, 0)` — an empty data
   define instead of the spec TypeError (ToPropertyDescriptor §10.1).
2. **Compile-time/runtime descriptor-state divergence** (`15.2.3.7-6-a-46`):
   after a define routed through a runtime path (descriptor held in a
   variable), a later static struct.set define trusted the compile-time
   `definedPropertyFlags` tracker (which had no entry) and skipped validation
   entirely — `{value: -0}` over a non-writable `+0` must throw.

## Fix

- **New finalize-pass exports** `__vec_set_elem(vec, i, v)` /
  `__vec_set_len(vec, n)` (src/codegen/index.ts, mirroring the
  `__vec_push`/`__vec_pop` per-vec-type dispatch + grow discipline), gated on a
  `__defineProperty*` import so defineProperty-free modules stay
  byte-identical.
- **`_vecDefineOwnProperty`** (src/runtime.ts): §10.4.2 array
  [[DefineOwnProperty]] — values go INTO the vec (elements + length field),
  attributes into the sidecar descriptor table; element-descriptor synthesis
  feeds `_validatePropertyDescriptor`; full ArraySetLength (ToNumber via the
  wasm-aware ToPrimitive, ToUint32 mismatch → RangeError, shrink stopping at
  non-configurable elements, writable-narrowing). Hooked ahead of the generic
  arm in `__defineProperty_value` / `_accessor` / `_desc` and both plural
  apply loops.
- **Vec-aware `_readOwnDescriptor`**: in-bounds elements and `length` read
  live from the vec (fixes `getOwnPropertyDescriptor(arr, "0")` returning
  undefined / bogus `__sget_` values).
- **Codegen**: `get/set: null|undefined` descriptor literals route to the
  dynamic runtime (spec TypeError / valid accessor semantics); static
  struct.set define paths (singular `useStruct` + the plural loop) are vetoed
  when `sidecarDefinedPropertyKeys` records a prior runtime define for the
  same `var:prop` (state then lives in the runtime sidecar;
  `_structFieldWriteback` keeps static reads correct on the routed path).

## Measured

In-process isolated cluster runs (intrinsic snapshot/restore between tests —
the dev-3022 pollution fix):

- `built-ins/Object/definePropert{y,ies}` baseline fails: 570 → 424
  (**+146 pass**).
- Regression controls, all verified against a main control run with the SAME
  in-process runner:
  - 600-file deterministic sample of baseline-passing `built-ins/Array/`
    tests → the only fails also fail on main (resizable-ArrayBuffer
    in-process artifacts).
  - full 2,513-file baseline-passing `built-ins/Object/` set → every
    residual non-pass either also fails on main or was in-process
    cross-test contamination (passes in isolation).
  - all 16 descriptor-related `tests/issue-*` vitest files (128 tests) →
    the single failure (`issue-2668` for-in prototype-attrs) also fails on
    main.
  - equivalence suite: identical 15-file/36-test failure set on main and on
    this branch (pre-existing local-env failures).

Two regression classes found DURING development and fixed before the PR:

1. Seeding default (configurable) flags for in-bounds elements suppressed the
   non-configurable rejection matrix for fresh-index defines, because the
   codegen pre-grows the vec (`maybeEmitVecLengthGrowth`) before the runtime
   call — `idx < oldLen` cannot distinguish a real element from a
   compiler-created hole (`15.2.3.6-4-252`). Fixed by treating no-entry
   indices as first definitions.
2. Extending the vec length for VALUE-less (accessor) defines beyond length
   turned previously-OOB reads (undefined) into hole-default reads
   (`15.2.3.6-4-312`). Fixed by deferring accessor-define length extension to
   the read-lane follow-up.

## Remaining (follow-up slices under #3022)

- Accessor defines on array indices are stored in the sidecar and validated,
  but typed element **reads** bypass accessors (the `15.2.3.7-6-a-262` /
  "accessed" cluster, ~80) — needs a read-lane hook.
- Descriptor-object field reads through the prototype chain / function-scope
  fnctor instances (~100, `15.2.3.6-3-*`) — #1712 machinery.
- Arguments-object exotic receivers (~57).
- Plain-object residual transition matrix (#3043): accessor
  `configurable:false→true` and data→accessor on the fully-static lane.
