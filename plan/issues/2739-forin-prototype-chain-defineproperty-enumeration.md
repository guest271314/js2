---
id: 2739
title: "for-in does not enumerate setPrototypeOf / constructor-prototype-chain properties; Object.defineProperty ordering"
horizon: l
status: done
sprint: 72
goal: test262-conformance
feasibility: hard
depends_on: []
priority: high
es_edition: ES5
language_feature: for-in
task_type: bug
created: 2026-06-27
updated: 2026-07-19
completed: 2026-07-16
assignee: ttraenkler/fable-delta
loc-budget-allow:
  - src/runtime.ts
---

# #2739 — for-in prototype-chain + defineProperty enumeration

## Problem

`for-in` over a shape-inferred struct does **not** enumerate properties reached
through a runtime prototype link, and `Object.defineProperty` perturbs creation
order. Split out of #2706/#2731 — these are NOT the delete/re-add asymmetry (that
is #2731, landed via PR #2170); they are a distinct prototype/defineProperty
enumeration bug class. Verified (host mode, current main):

**(a) `Object.setPrototypeOf` chain not walked.**

```ts
var proto = { p4: 'p4' };
var o = { p1: 'p1', p2: 'p2', p3: 'p3' };
Object.setPrototypeOf(o, proto);
for (var k in o) …          // yields "p1,p2,p3" — proto's "p4" is MISSING
                            // (expected ['p1','p2','p3','p4'])
```

**(b) Constructor-function `prototype` chain not walked, with own-shadows-proto.**

```ts
function FACTORY(){ this.prop = 1; this.hint = "hinted"; }
FACTORY.prototype = { feat: 2, hint: "protohint" };
var __instance = new FACTORY;
for (key in __instance) …   // must visit own prop/hint AND inherited feat,
                            // with own hint shadowing proto hint; currently
                            // throws / drops inherited keys
```

**(c) `Object.defineProperty` must not reorder creation order.**

```ts
var obj = {}; obj.a = 1; obj.b = 2;
Object.defineProperty(obj, "a", { value: 11 });
for (var k in obj) …        // must stay ["a","b"] (define does not re-create)
```

Spec: §13.7.5.15 EnumerateObjectProperties — after own keys (OrdinaryOwnPropertyKeys
order), walk `[[GetPrototypeOf]]` and visit each level's enumerable own keys,
skipping any already-visited (shadowed) key.

## Failing tests (test262 baseline)

```
test/language/statements/for-in/order-property-on-prototype.js   (a)
test/language/statements/for-in/S12.6.4_A6.js                    (b)
test/language/statements/for-in/S12.6.4_A6.1.js                  (b)
test/language/statements/for-in/order-after-define-property.js   (c)
```

## Root cause (suspected) — for the architect

`__for_in_keys` (`src/runtime.ts`) already has a manual prototype-chain walk
(`Object.getPrototypeOf(current)`), but for a shape-inferred WasmGC struct:

- `Object.setPrototypeOf(struct, proto)` likely sets a host-side proto link that
  `Object.getPrototypeOf(struct)` in the walk does NOT observe (the struct's
  native `[[Prototype]]` is not the user `proto`), so the proto level is never
  visited.
- A constructor-function (`function FACTORY(){…}; FACTORY.prototype = {…};
new FACTORY`) builds an instance whose prototype is the function's `.prototype`
  object — the runtime must link the instance to that prototype object so the
  for-in walk reaches `feat`, with `hint` shadowing.
- `defineProperty` ordering: `__object_keys`/`__for_in_keys` must treat a
  `defineProperty` on an EXISTING key as not re-creating it (no reorder).

This needs a coherent prototype-link model for shape-inferred structs +
`Object.getPrototypeOf` consistency in the for-in walk — architect-scope, and a
sibling of #2706's remaining "prototype-chain dedup" goal.

## Acceptance criteria

The 4 tests above flip fail→pass. No regression in `statements/for-in/`. Host
mode (the standalone prototype-link model is a separate sub-case). Full CI green.

## Notes

- Split from #2706 / #2731 (esch, 2026-06-27). #2731 (PR #2170) closed only
  `order-simple-object` (the delete/re-add half); #1830 (PR #2160) closed the
  integer-index half. These 4 are the remaining prototype/defineProperty half.
- Route to **architect** for a prototype-link spec. Overlaps #2706's
  "prototype-chain dedup" scope and the #2580/#2660 substrate.

## Implementation Plan (architect: esch, 2026-06-27)

**All claims below VERIFIED by compile+run on current `origin/main` HEAD
(f51590644910a), host/gc mode, via `compile()` + `buildImports`/`instantiateWasm`
probes and the real `runTest262File` runner.** The three sub-bugs split into
**two root causes** plus one separate lower-confidence item:

### Root cause

**Shape-inferred and fnctor WasmGC structs have NO host-observable `[[Prototype]]`
link that `__for_in_keys`' manual walk can follow.** The walk in `__for_in_keys`
(`src/runtime.ts:10844-10906`) advances with `current = Object.getPrototypeOf(current)`
(`:10902`). For an opaque WasmGC struct exported to JS, host `Object.getPrototypeOf`
returns null/the engine default — **never** the user-intended prototype. The link
is also never _recorded_ at the two mutation sites:

- **(a) `Object.setPrototypeOf(o, proto)` is a COMPLETE NO-OP in gc/host mode.**
  `src/codegen/expressions/calls.ts:5943-5949` compiles both args, `drop`s `proto`,
  returns `obj`. The comment claims "the host runtime owns proto" but codegen never
  calls any host `setPrototypeOf` — the link is dropped on the floor. Verified:
  `Object.setPrototypeOf(o,{p4})` then `for k in o` yields `p1,p2,p3` (no `p4`).

- **(b) `new F()` builds a `$__fnctor_F` struct with no prototype link, and
  `F.prototype = {...}` is silently dropped in host mode.** `new FACTORY` →
  `compileNewFunctionDeclaration` (`new-super.ts:1004`) builds a `$__fnctor_FACTORY`
  struct with fields `prop`,`hint`. Its `__register_fnctor_instance` registration
  (`new-super.ts:1267-1287`) fires **only when `ctorGlobalIdx` is defined** — i.e.
  the fnctor has a closure global. A fnctor that is _only_ `new`'d (never used as a
  value) has **no** closure global, so registration never fires (WAT-verified:
  `__fn_closure_FACTORY` absent, `__register_fnctor_instance` absent). Separately,
  `FACTORY.prototype = {feat,hint}` routes through `tryCompileFnctorPrototypeAssign`
  (`assignment.ts:2489-2498`) which is **standalone-only**; in host mode it falls to
  `__extern_set($closure,"prototype",…)` which (per the in-code comment) "misses
  `ref.test $Object` and silently drops the write". Net: the `F.prototype` object and
  the `new F()` instance never rendezvous on a shared identity. Verified: own fields
  enumerate (`prop1`,`hinthinted` — own `hint` correctly shadows), but inherited
  `feat` is MISSING from for-in AND `__instance.feat`/`__instance["feat"]` read
  `undefined` (the instance has no proto link the read path can walk either).

So (a) and (b) are the **same** missing-prototype-link defect at two construction
sites, both surfacing in the SAME `__for_in_keys` walk.

### Changes

**Part 1a — record the setPrototypeOf link (host mode).**

- `src/runtime.ts`: add `const _wasmStructProto = new WeakMap<object, any>();`
  (sibling of `_wasmStructProps`/`_wasmStructDeletedKeys`/`_wasmStructShadowedFields`).
- `src/runtime.ts`: add a host import `__host_set_struct_proto(obj, proto)` that, when
  `_isWasmStruct(obj)` and `proto` is object-or-null, performs the §10.1.2.1
  OrdinarySetPrototypeOf extensibility + cycle checks (mirror the native
  `__object_setPrototypeOf` logic, object-runtime.ts:2426), then
  `_wasmStructProto.set(obj, proto)` and returns `obj`. Register its name so
  `buildImports` wires it.
- `src/codegen/expressions/calls.ts:5943-5949` (the gc/host arm): instead of
  `drop`+return, emit `call __host_set_struct_proto(obj, proto)` (ensureLateImport
  - flushLateImportShifts, same discipline as the standalone arm at :5927-5935).
    Mirror at **`Reflect.setPrototypeOf`** (calls.ts:7593) and the `o.__proto__ = v`
    write path (grep `__proto__` in assignment.ts) so all three record the link.

**Part 1b — record the fnctor instance→prototype link (host mode).** Pick ONE:

- _Preferred (reuse #1712 machinery):_ ensure `__register_fnctor_instance` fires for
  EVERY `new`'d fnctor. At `new-super.ts:1267`, when `ctorGlobalIdx` is undefined,
  allocate the closure global for `funcName` (the same lazy global `closures.ts:4300`
  mints) so the registration emits, AND make `F.prototype = {...}` vivify the SAME
  closure-sidecar prototype object in host mode (extend `tryCompileFnctorPrototypeAssign`
  / its host fall-through to write `_sidecarSet(closure,"prototype",rhs)` via
  `_getOrVivifyFnPrototype`). Then `_fnctorInstanceCtor`→`_sidecarGet(ctor,"prototype")`
  is the link, and the existing read path (`_fnctorProtoLookup`, runtime.ts:74) already
  resolves inherited reads — closing the `__instance.feat`→undefined half of (b).
- _Alternative (name-keyed rendezvous):_ a host `Map<string,object> _fnctorPrototypeByName`;
  `F.prototype = {...}` (host) writes it; construction does
  `_wasmStructProto.set(instance, _fnctorPrototypeByName.get(F))`. Simpler but a second
  proto-link channel; prefer reusing `_fnctorInstanceCtor` to avoid divergence.

**Part 2 — consult the link in the for-in walk (fixes a + b enumeration).**

- `src/runtime.ts`: add `_structUserProto(current, exports)` returning, for a wasm
  struct: (1) `_wasmStructProto.get(current)` if set; else (2) the fnctor prototype
  via `_fnctorInstanceCtor.get(current)` → `_sidecarGet(ctor,"prototype")`; else (3)
  `Object.getPrototypeOf(current)`. For a non-struct, return `Object.getPrototypeOf`.
- `__for_in_keys` (runtime.ts): replace the `current = Object.getPrototypeOf(current)`
  step at `:10902` with `current = _structUserProto(current, exports)`. The existing
  `seen` set + `_orderOwnKeysSpec` already give own-before-proto ordering and
  own-shadows-proto dedup (verified: own `hint` already wins). The proto level may
  itself be a wasm struct (`{p4}`/`{feat,hint}` compile to structs) — the walk's
  struct branch (`:10850`) already handles that recursively.

**Part 3 — read-path consistency (already mostly covered).**

- For (b) the test reads `__instance[key]`; once Part 1b registers the link,
  `_fnctorProtoLookup` (consulted by `__extern_get` at runtime.ts:4170/4977) resolves
  inherited reads. ALSO have `_fnctorProtoLookup` (or a shared resolver) consult
  `_wasmStructProto` so setPrototypeOf-set protos resolve reads too — keeps reads and
  for-in walking ONE prototype source.

**Part 4 — `__getPrototypeOf` consistency (recommended, not strictly required by the
4 tests).** Route `__getPrototypeOf` (runtime.ts:9353) through `_structUserProto` for
wasm structs so `Object.getPrototypeOf(o)` post-setPrototypeOf returns the user proto.
Guard against regressing existing proto-walk tests (run the `Object/getPrototypeOf`
and `setPrototypeOf` test262 dirs).

### Edge cases

- `Object.setPrototypeOf(o, null)` → store null; for-in then enumerates own keys only.
- Cycle: OrdinarySetPrototypeOf must refuse a cycle (no-op); ALSO add a visited-object
  guard in the `__for_in_keys` walk (the `_fnctorProtoLookup` uses `guard++ < 16`) so a
  hand-built cycle can't loop the enumerator.
- own-shadows-proto: `seen` is populated with own keys BEFORE the proto level — already
  correct; do not reorder.
- proto level is a plain JS object vs a wasm struct — both branches already exist.
- Standalone/WASI is OUT OF SCOPE for these 4 tests (host mode). Standalone already has
  `$Object.$proto` (calls.ts:5909) + fnctor S3a reconstruction; a separate sub-case.
- Do NOT regress `for-of` over objects if it shares `__for_in_keys` (it does not today —
  verify before shipping).

### (c) `order-after-define-property` — SEPARATE, lower-confidence sub-task

Verified split: assert #1 (plain object: `obj.a=1;obj.b=2;defineProperty(obj,"a",{value})`
→ `["a","b"]`) **already PASSES** on current main. Only assert #2 (the **array +
accessor-descriptor** case: `defineProperty(arr,"a",{get,enumerable,configurable})`;
`arr.b=2`; redefine `a`) fails — AND it fails **only in the full-harness `runTest262File`
run**; an isolated `compile()` probe of the same array snippet returns the correct
`["a","b"]` (len=2). This is a full-program-compilation interaction (array vec +
accessor-descriptor sidecar for-in under the assert.js harness), NOT the
prototype-link defect. **Treat as its own follow-up**; the dev MUST reproduce via
`runTest262File(".../order-after-define-property.js")` (it does NOT repro in a bare
`compile()` probe). Do not block (a)+(b) on it. Recommend the PO file (c) as a separate
issue if (a)+(b) ship first.

### Test files to verify

- `statements/for-in/order-property-on-prototype.js` — Part 1a + Part 2 (a)
- `statements/for-in/S12.6.4_A6.js`, `S12.6.4_A6.1.js` — Part 1b + Part 2 + Part 3 (b)
- `statements/for-in/order-after-define-property.js` — (c), separate sub-task
- Regression watch: `statements/for-in/` (esp. `order-simple-object` from #2731),
  `built-ins/Object/getPrototypeOf`, `built-ins/Object/setPrototypeOf`.

## Residual (as of #2199, PO reconcile 2026-06-28)

NOT done — sliced. Part (a) (for-in walks a setPrototypeOf prototype chain) landed. The remaining parts — full setPrototypeOf-chain enumeration + defineProperty-driven enumeration ordering on the prototype chain — remain. Stays in-progress.

## Resolution (fable-delta, 2026-07-16)

Part (b) — the fnctor constructor-prototype chain — landed in this PR. Two
distinct defects on then-current main (78a091c574), both fixed in
`src/runtime.ts`:

1. **for-in never walked the fnctor instance→ctor→prototype link.**
   `_structUserProto` deliberately skipped it (carved out when (a) landed).
   Fixed by extracting the ctor→prototype resolution out of
   `_fnctorProtoLookup` into `_fnctorCtorProto(obj, exports)` (sidecar
   `prototype` + `__sget_prototype` struct-slot fallback, per #3123) and
   consulting it from `_structUserProto` after the explicit `_wasmStructProto`
   record. Reads and enumeration now share ONE prototype source (spec Part 3).

2. **Own typed struct FIELD was shadowed by the prototype on dynamic reads**
   (`inst["hint"]` returned proto `"protohint"` instead of own `"hinted"`).
   In `_safeGet`, `_fnctorProtoLookup` ran BEFORE the own-field fast path
   (which lives in `__extern_get`'s post-`_safeGet` fallback). Fixed by
   consulting the own field (shape-gated via `_getStructFieldNames`, tombstone-
   aware) before serving a proto hit — §7.3.2 [[Get]] own-shadows-proto.

3. **Follow-on:** once the walk reached proto levels, a NON-enumerable own
   sidecar/descriptor property no longer shadowed a same-named enumerable proto
   property (12.6.4-2.js). Fixed by marking ALL own keys (fields + sidecar +
   descriptor-table, enumerable or not, minus delete-tombstoned) as `seen`
   at each struct level of the `__for_in_keys` walk (§13.7.5.15 `visited`).

Sub-case (c) (`order-after-define-property.js` — array + accessor-descriptor
redefine, full-harness-only repro) is a separate defect → split to **#3323**
per the architect's recommendation.

## Test Results (2026-07-16, branch issue-2739-forin-proto-chain)

- `statements/for-in/S12.6.4_A6.js` fail→pass; `S12.6.4_A6.1.js` fail→pass
- `statements/for-in/order-property-on-prototype.js` stays pass (part a)
- `statements/for-in/` full-dir sweep vs baseline: 0 regressions
  (12.6.4-2.js initially regressed — non-enumerable-own-shadow — fixed by
  item 3 above; final sweep clean)
- 19/19 baseline-passing tests importing `__register_fnctor_instance` +
  `__for_in_keys` (the at-risk fnctor set): 0 regressions
- 43-file sample of baseline-passing `__for_in_keys` tests: clean (one
  load flake, `acquire-properties-from-array.js`, passes 3/3 re-run and on
  isolated probe)
- vitest: `issue-2739` (6/6, incl. 3 new (b) tests), `issue-2731`,
  `issue-3123`, `issue-3138`, `issue-3139`, `issue-2680`, `issue-1712` all
  green on the branch
- `order-after-define-property.js` still fails (assert #2) → #3323
