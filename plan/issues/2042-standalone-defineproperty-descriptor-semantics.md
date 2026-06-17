---
id: 2042
title: "standalone: Object.defineProperty/defineProperties residual — __obj_insert illegal cast + descriptor semantics over $Object (~340 tests)"
status: in-progress
sprint: Backlog
created: 2026-06-10
updated: 2026-06-14
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime
language_feature: objects, property-descriptors
goal: standalone-mode
related: [1888, 1472, 1905, 739, 797]
test262_bucket: standalone-defineproperty
test262_count: 340
es_edition: es5
origin: "2026-06-10 standalone-vs-host baseline diff: 365 defineProperty + 177 defineProperties gap rows; ~217 are #1472/#1888-owned refusals, the rest are real standalone runtime bugs tracked here."
---

# #2042 — standalone defineProperty/defineProperties residual

## Problem

`built-ins/Object/defineProperty` (365 gap rows) + `defineProperties` (177)
split into three failure classes in standalone where host passes:

**A. Runtime trap — compiler bug (37+ rows):**
`illegal cast [in __obj_insert() ← __defineProperty_value ← test]`
e.g. `built-ins/Object/defineProperty/15.2.3.6-4-*`. The supported
`__defineProperty_value` fast path itself feeds `__obj_insert` a
wrongly-typed key or value (likely numeric/symbol key reaching the
string-keyed insert arm). This is the same `$Object` runtime as #2039's
`__obj_find` signature and could be fixed in the same slice.

**B. Wrong descriptor semantics — runtime asserts (~300 rows incl.
defineProperties):** tests that compile and run but fail
`verifyProperty(...)` / flag checks:

- `assert(accessed, 'accessed !== true')` — accessor `get`/`set` from the
  descriptor object never invoked,
- `assert.sameValue(beforeWrite, true, 'beforeWrite')` — ValidateAndApply
  ordering ([§10.1.6.3](https://tc39.es/ecma262/#sec-validateandapplypropertydescriptor)),
- `assert(propertyDefineCorrect, …)` — attribute defaults (writable/
  enumerable/configurable default **false** for fresh descriptors,
  [§6.2.6.6 CompletePropertyDescriptor](https://tc39.es/ecma262/#sec-completepropertydescriptor)),
- redefinition rejections that must throw TypeError and don't.

**C. Loud refusals (already owned — NOT this issue):** ~217 rows
`'__defineProperty_desc' … is not yet supported in --target standalone
(#1472 Phase B)` — accessor-descriptor support is #1888 Slice 5 (D5,
`$PropEntry` funcref slots). This issue should land after or alongside that
slice and re-measure.

## Suggested approach

1. Fix A first (small, mechanical): typed-key dispatch before `__obj_insert`
   — numeric and symbol keys must take their own arm or be normalized; add a
   brand check instead of an unconditional `ref.cast`.
2. For B: implement ValidateAndApplyPropertyDescriptor over the `$PropEntry`
   flag word — attribute defaults, [[Configurable]] transition rules, and
   TypeError on invalid redefinition. `verifyProperty` harness coverage makes
   the spec-order observable, so follow §10.1.6.3 step order exactly.
3. Re-run the defineProperty/defineProperties directories standalone and
   reassign any residual rows.

## Acceptance criteria

- 0 `illegal cast` rows under `built-ins/Object/defineProperty` standalone.
- `verifyProperty`-based attribute-default and redefinition tests pass
  (≥150 of the ~300 class-B rows).
- TypeError thrown (catchable) on invalid redefinitions — no traps.
- Host mode unchanged; equivalence test for numeric + symbol keys through
  `Object.defineProperty` in standalone.

## Progress

### PR-A — key cast fix (2026-06-14, dev-b) — DONE

ToPropertyKey the `Object.defineProperty` key at the call site so a numeric /
boxed key reaches the string-keyed `$Object` runtime as a `$AnyString`,
eliminating the `illegal cast` trap (class A, 37+ rows).

- New helper `emitStandaloneDefinePropertyKeyToString` in
  `src/codegen/object-ops.ts` routes the compiled key externref through
  `__extern_toString` (host import in JS mode; native runtime helper in
  standalone), gated on `ctx.standalone` so host output stays byte-identical
  (the host `__defineProperty_value` JS import ToPropertyKeys the key itself and
  would alias a pre-stringified Symbol).
- Applied symmetrically in both the value path
  (`emitExternDefinePropertyValue`) and the accessor path
  (`emitExternDefinePropertyNoValue`).
- Verified: `Object.defineProperty(o, 0, {value:5})` no longer traps in
  standalone (was `illegal cast`); string-key define round-trips unchanged
  (`o.foo`); host mode untouched. Tests in `tests/issue-2042.test.ts`.
- Symbol keys: out of scope for Part A (the string-keyed runtime cannot
  represent them); the `15.2.3.6-4-*` illegal-cast rows are numeric, not symbol.

### Remaining (PR-B — senior follow-up)

- ValidateAndApplyPropertyDescriptor / CompletePropertyDescriptor over the
  `$PropEntry` flag word (class B, ~300 rows): attribute defaults, redefinition
  rules, catchable TypeError. Out of scope for this PR.
- Standalone defineProperty value readback via numeric/computed member access
  (`o[0]`) and enumeration (`Object.keys` / `getOwnPropertyNames`) over
  defineProperty'd keys are separate pre-existing gaps (the latter is refused
  loud under #1472 Phase B) — not introduced by PR-A.

## S3 — descriptor-reflection natives, READ SIDE (2026-06-17, dev-2)

Landed the read-side descriptor-reflection natives over `$Object`/`$PropEntry`,
host-free under `--target standalone`/`wasi` (previously refused #1472 Phase B):

- **`__getOwnPropertyNames`** — own string keys INCLUDING non-enumerable, in
  OrdinaryOwnPropertyKeys order (§10.1.11.1: integer indices ascending, then
  string keys by insertion). Backed by a new **`__obj_ordered_all`** sibling of
  `__obj_ordered` (same compaction + selection sort; the `FLAG_ENUMERABLE`
  filter dropped). The two register from a shared `buildOrderedBody(includeNonEnum)`
  factory but each gets a FRESH locals array — `registerNative` stores the locals
  array by reference and a later lowering pass mutates it, so sharing one
  cross-corrupted both (root-caused an `array.len expected arrayref` emit error).
- **`__getOwnPropertySymbols`** — always `[]` (the string-keyed `$Object` runtime
  holds no symbol keys; correct for every symbol-free object, which is all of
  them here). Lets symbol-free tests pass instead of refusing.
- **`__object_getOwnPropertyDescriptors`** (the `__object_`-prefixed name the
  call site requests) — fresh `$Object` mapping each own key (from
  `__getOwnPropertyNames`) to `__getOwnPropertyDescriptor(o, key)`. Reuses the
  singular descriptor builder so accessor/data shape + flags stay consistent.

All in `src/codegen/object-runtime.ts`; names added to
`OBJECT_RUNTIME_HELPER_NAMES` so they resolve native (define ⇒ no import ⇒ no
index shift) ahead of the Phase-A refuse gate. Host/gc output byte-identical
(the JS imports own those paths there).

Tests: `tests/issue-2042-s3.test.ts` (9 cases — names count/non-enumerable
inclusion/int+string keys, symbols [], descriptors per-key + coverage, empty
receiver, Object.keys-unregressed control, host-free compile). All pass;
prettier/biome/tsc clean. Sampled real test262: `getOwnPropertyNames` 10/20,
`getOwnPropertyDescriptors` 5/18 now pass standalone (were ~all refused).

**Deferred — WRITE SIDE (`__defineProperty_desc`):** implemented in principle
(delegate to the working native `__defineProperties` via a one-entry
`{ [key]: desc }` map — verified `Object.defineProperties` works), but its sole
call site (`Object.create(o, descs)` with an identifier descriptor value) trips
the **#2043** late-import index-shift emit bug, so registering it converts a
clean refusal into a messier #2043 binary-emit error with NO test gain. Left as
a loud refusal until #2043 is fixed; the helper + its set entry land then as a
follow-up. Issue stays `in-progress` for S4 (ValidateAndApplyPropertyDescriptor)
and the deferred write side.

Coordination: S1 (#33, dev-1) and S3 both edit `object-runtime.ts` (the
`OBJECT_RUNTIME_HELPER_NAMES` set + `ensureObjectRuntime`); my entries append at
the end to minimize overlap. Whoever merges second resolves the small conflict.
