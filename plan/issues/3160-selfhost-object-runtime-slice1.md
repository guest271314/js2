---
id: 3160
title: "Self-hosted stdlib: object-runtime slice 1 — getOwnPropertyDescriptors + fromEntries via our own IR pipeline"
status: done
assignee: ttraenkler/fable-senior2
sprint: 71
created: 2026-07-12
updated: 2026-07-13
completed: 2026-07-12
priority: high
horizon: m
feasibility: hard
reasoning_effort: high
task_type: refactor
area: codegen, stdlib, ir
language_feature: compiler-internals
goal: ir-full-coverage
related: [3141, 3161, 3159, 2042]
depends_on: [3161]
origin: "plan/self-hosting-scale-up.md family #8 (object-runtime) — bounded PUREST-first slice; bloat-reduction flagship lever"
loc-budget-allow:
  - src/stdlib/object-runtime.ts
---

# #3160 — Self-hosted object-runtime slice 1

## Problem

`src/codegen/object-runtime.ts` (10,598 lines) is the biggest single hand-emitted
builtin family and the flagship bloat-reduction target. The scale-up plan ranks it
family #8 ("convert LAST") because the dynamic property model is rep-entangled
(tag-5 classifier, descriptors, prototype chain). But a bounded PUREST-first slice
is landable now: the two most self-contained helpers are thin compositions over
already-registered funcMap helpers with zero struct/identity/MOP entanglement.

## Slice scope (this PR)

Convert to TS source (`src/stdlib/object-runtime.ts`), compiled through the
generalized self-hosting driver (#3161), replacing the hand-emitted `Instr[]`
bodies in `ensureObjectRuntime`:

- `__object_getOwnPropertyDescriptors(obj)` — fresh object mapping each own key
  (from `__getOwnPropertyNames`) to `__getOwnPropertyDescriptor(obj, key)`.
- `__object_fromEntries(entries)` — fresh object, `out[pair[0]] = pair[1]` per pair.

Both are pure compositions over six funcMap helpers registered EARLIER in the same
pass (`__new_plain_object`, `__extern_length`, `__extern_get_idx`, `__extern_set`,
`__getOwnPropertyNames`, `__getOwnPropertyDescriptor`) — leaf-first, no new Wasm.

## Why NOT the rest of object-runtime (documented so the next slice knows)

Everything else in the file is rep-entangled exactly as the plan predicted:

- `__object_assign` walks the RAW hash table directly — converting compositionally
  via `__object_keys` would CHANGE observable enumeration order.
- `__object_is` needs `i64.reinterpret_f64` + `ref.test` on the eq-heap for
  SameValue bit-pattern comparison.
- integrity predicates / hasOwn / propertyIsEnumerable / isPrototypeOf all
  `struct.get $Object`/`$PropEntry`.
  These need **Precursor D** (typed struct intrinsics) — a later slice.
- `__object_groupBy` is ALMOST pure but needs `group === null` on an externref
  local, which from-ast's `tryFoldNullCompare` deliberately bails on
  (`from-ast.ts:6263`; TODO at :6233 "emit ref.is_null directly from the IR").
  Deferred as a dialect FINDING — the next slice unblocks once that gap closes.

## Acceptance criteria

- [x] Both helpers compiled from TS source through the IR pipeline; hand `Instr[]`
      bodies deleted from `object-runtime.ts` (−145 lines in the family file).
- [x] Behaviour preserved: `tests/issue-3160.test.ts` (8 standalone cases) +
      existing `tests/issue-2042-fromentries-objvec.test.ts` (8) +
      `tests/issue-2042-s3.test.ts` all green.
- [x] No host-import leak in standalone (`__object_*` never appears in env imports).
- [x] Host mode byte-inert (these are JS imports there — native bodies absent;
      SHA-identical binary main vs branch).
- [x] Standalone: identical function count (228) main vs branch — the two helpers
      are always-retained roots (`OBJECT_RUNTIME_HELPER_NAMES`), so the change is a
      behaviour-equivalent body-swap (+97 bytes), NOT dead-code bloat or a DCE
      regression.
- [x] LOC gate green; compiler-source NET −18 (object-runtime.ts −145 + new
      127-line stdlib file). Subsequent object-runtime slices reuse this file's
      header → strongly negative.

## Findings (dialect / driver)

- Object.fromEntries over an EMPTY array literal `[]` still hits a pre-existing
  CALL-SITE refusal (the #2042 normalisation only recognises non-empty string-key
  pair literals) — orthogonal to the helper body; not in this slice.
- The f64-vs-i32 loop-counter representational difference from the hand body is
  value-equivalent for the < 2^53 index range these iterate (documented in the
  stdlib source header).

## Implementation notes (WHY)

- Slicing PUREST-first is the whole risk-management strategy for object-runtime:
  these two helpers touch NONE of the rep machinery that makes the family family-#8
  hard, so the slice is a clean composition swap provable by the existing #2042
  equivalence suites plus the new #3160 cases — no new proof infrastructure.
- The self-hosted funcs are registered via the same `mintDefinedFunc`/
  `pushDefinedFunc`/`funcMap.set` path as the hand bodies (through
  `emitSelfHostedFunc`), so every downstream pass (late-import fixups, DCE, binary
  emit) treats them identically — which is why the standalone function count is
  unchanged and host mode stays byte-inert.
