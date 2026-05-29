---
id: 1629
title: "spec gap: Object.defineProperty — descriptor attribute fidelity (664 test262 fails, biggest single bucket)"
status: ready
created: 2026-05-08
updated: 2026-05-29
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: object
goal: spec-completeness
sprint: Backlog
renumbered_from: 1335
parent: 1328
related: [1629a, 1629b, 1629c, 1630, 1631, 1130, 1364b]
---

> **UNIFIED DESCRIPTOR-MODEL SPEC (architect, 2026-05-29).** The single
> coherent implementation plan for the whole Object property-descriptor
> family is the **"## Unified Implementation Plan — Object property-descriptor
> model"** section at the bottom of this file. It supersedes the per-sub-cluster
> notes above as the *sequencing* authority; the older sections remain as the
> historical record of #1629a/#1629b (both merged) and the original mis-scoped
> investigations. Tech lead schedules the slices (S1–S6); each is
> independently shippable and net-positive on full CI.

> **Sprint 56 close-out (2026-05-29):** carried over to Backlog. Two of the
> three sub-clusters landed this sprint — **#1629a** (dynamic/non-literal
> descriptor materialization, PR #835) and **#1629b** (`getOwnPropertyDescriptor`
> attribute read-back for plain-object struct fields). The remaining residual is
> **#1629c** — Array/Function *exotic* `defineProperty` semantics, the largest
> sub-cluster, which overlaps **#1130** (`status: in-review`). Live baseline
> `9ee8e921` (2026-05-29) still shows ~1,000 non-passing tests across the
> `Object.defineProperty` / `getOwnPropertyDescriptor` family, so the umbrella is
> **not** done. #1629c needs the attribute-table + struct-descriptor-read design
> from the Implementation Plan below, gated behind / coordinated with #1130.

# #1335 — Object.defineProperty: descriptor attribute fidelity

## Problem

`built-ins/Object/defineProperty` test262 bucket is the single largest fail bucket in the
audit: **467 / 1131 pass (41.3%) — 664 fails (600 assertion_fail, 32 other, 16 runtime_error,
7 type_error, 5 wasm_compile)**.

Spec §10.1.6 (OrdinaryDefineOwnProperty) and §20.1.2.4 (Object.defineProperty) require:

1. **Property attributes** (`writable`, `configurable`, `enumerable`) tracked **per property**.
2. **Accessor properties** (`get`/`set`) stored separately from data properties.
3. **Type-checking** the descriptor — non-object descriptors throw TypeError.
4. **Validating** descriptor invariants: a non-configurable property cannot become configurable,
   non-writable cannot become writable, the descriptor type cannot flip from data to accessor, etc.
5. **Coalescing** missing descriptor fields with defaults (writable/configurable/enumerable default
   to false; data-descriptor `value` defaults to undefined).

The current js2wasm implementation in `src/codegen/object-ops.ts` and `src/runtime.ts`:
- Sets the field value but **does not record the attribute flags** for typed structs.
- Only the externref/host path retains attributes (it forwards to host `Object.defineProperty`).
- For typed (struct-backed) objects, redefining a non-configurable property silently succeeds.

## Acceptance criteria

1. `built-ins/Object/defineProperty/15.2.3.6-3-*` (descriptor coalescing) tests pass.
2. `built-ins/Object/defineProperty/15.2.3.6-4-*` (configurable invariants) tests pass.
3. `built-ins/Object/defineProperty/15.2.3.6-5-*` (writable invariants) tests pass.
4. Pass-rate for `built-ins/Object/defineProperty` rises from 41.3% to ≥75%.
5. Object.defineProperties and Object.create(o, descriptors) inherit the fix.

## Files to modify

- `src/codegen/object-ops.ts` — descriptor compilation, attribute storage
- `src/codegen/property-access.ts` — attribute checks on get/set/delete
- `src/runtime.ts` — runtime helpers for typed-object descriptor table

## Implementation Plan

### Root cause

Typed (WasmGC struct) objects have no attribute storage — every property is implicitly
`{writable:true, configurable:true, enumerable:true}`. The descriptor passed to
`Object.defineProperty` is parsed for its `value` but the attribute bits are dropped on the floor.

### Approach

Add a parallel attribute-table struct to typed objects:

```
(type $AttrEntry (struct (field $key (ref string)) (field $flags i32)))
;; flags: bit 0 = writable, bit 1 = enumerable, bit 2 = configurable, bit 3 = isAccessor
(type $AttrTable (array (mut (ref null $AttrEntry))))
;; Object struct gains an extra (mut (ref null $AttrTable)) — null means "all defaults".
```

When `Object.defineProperty` is called:
1. Parse the descriptor (a JS object) into `(value, flags)` pairs at compile time when possible,
   or at runtime via `__parse_descriptor` host import.
2. Lazily allocate `$AttrTable` on first non-default-attribute write.
3. On subsequent writes, look up by key and validate invariants.

### Edge cases

- Descriptor is null/undefined → TypeError at the call site.
- Descriptor has both `value` and `get` → TypeError (data + accessor mix).
- Descriptor argument is a Proxy → must trap on `[[Get]]` for each known key.
- Property already non-configurable → reject incompatible redefinition (return false in
  Reflect.defineProperty / throw in Object.defineProperty).

### Test262 sample

- `test262/test/built-ins/Object/defineProperty/15.2.3.6-1-1.js` (undefined → TypeError)
- `test262/test/built-ins/Object/defineProperty/15.2.3.6-3-1.js` (default attribute coalescing)
- `test262/test/built-ins/Object/defineProperty/15.2.3.6-4-82.js` (non-configurable invariants)

## Investigation (2026-05-27, dev-1607)

Authoritative baseline (`.test262-cache/test262-current.jsonl`, HEAD 1f9ada252):
**502 pass / 624 fail / 5 compile_error** in `built-ins/Object/defineProperty`.

Fail clusters by filename prefix:

| cluster        | fails | notes |
|----------------|-------|-------|
| `15.2.3.6-4-*` | 436   | step-4 [[DefineOwnProperty]] semantics |
| `15.2.3.6-3-*` | 173   | ToPropertyDescriptor / coalescing |
| `15.2.3.6-2-*` | 8     | property-key coercion |
| misc           | ~7    | symbol/typedarray/coerced-P/etc. |

Within c4 (431 sampled): **188 function-involving, 133 array-involving, 83 plain-object**.
The bulk target **Array / bound-Function exotic objects** (length/index semantics,
accessor-on-array), which are host-backed externrefs — a separate problem from the
issue's stated "typed-struct attribute table" plan.

### Root cause confirmed for the plain-object + dynamic-descriptor subset

`Object.defineProperty` is **compile-time inlined** in `src/codegen/object-ops.ts`
(`compileObjectDefineProperty`); no `__defineProperty_*` import is emitted for the
common cases. All descriptor analysis (value / get / set / writable / enumerable /
configurable extraction, the data+accessor-mix TypeError at line 736, struct-field
attribute storage) is guarded by `if (ts.isObjectLiteralExpression(descArg))`.

When the descriptor is passed as a **variable** (e.g. `var desc = {get, value};
Object.defineProperty(o, "foo", desc)` — the dominant c3 shape), NONE of that fires:
- `valueExpr`/`getNode`/`descWritable`/… are all `undefined`,
- the data+accessor-mix check sees `hasData=false, hasAccessor=false` → no throw,
- it falls to the `else` branch → `emitExternDefinePropertyNoValue`, which emits
  `__defineProperty_value(obj, prop, null, flags)` with statically-empty flags and
  **never passes the real descriptor's value/get/set to the runtime**. No validation,
  no storage. Reproduced: variable-descriptor `{get,value}` mix returns 0 (no throw);
  test262 expects TypeError.

Separately, even for the inline-literal plain-object path,
`Object.getOwnPropertyDescriptor(o,"foo").writable` returns the default `true` for a
brand-new (non-struct-field) property defined via `defineProperty({value:101})` — the
flags are stored in `ctx.definedPropertyFlags` / sidecar but `shapePropFlags` is only
updated when the prop is an existing struct field (`userIdx >= 0`), so descriptor
read-back misses them. (4-17 family.)

### Why there is no small fix

Routing the dynamic-descriptor case to the existing-but-dead runtime
`__defineProperty_desc(obj, prop, desc)` (runtime.ts:4045) does NOT work as-is: the
descriptor object is itself a WasmGC struct, and that helper's `getField` reads struct
descriptors via `_sidecarGet`, which returns `undefined` for real struct fields (`get`/
`value` live as `__sget_*` exports, not sidecar). So the runtime cannot read an opaque
struct descriptor's fields. A correct fix needs either (a) materializing the descriptor
struct into a JS object before the runtime call, or (b) teaching `getField` to read
struct fields through the exported getters. Both are non-trivial.

**Conclusion:** the 624 fails do not reduce to one localized patch. The biggest sub-clusters
(Array/Function exotic defineProperty) are a distinct workstream; the plain-object subset
needs the attribute-table + struct-descriptor-read design in the Implementation Plan above.
Recommend splitting into sub-issues:
- **#1629a** — dynamic (non-literal) descriptor: materialize struct descriptor → route to
  runtime `__defineProperty_desc` with working field reads (covers most of c3, ~150).
- **#1629b** — `getOwnPropertyDescriptor` attribute read-back for non-struct-field
  defined props on plain objects (4-17 family).
- **#1629c** — Array/Function exotic defineProperty semantics (the 321 array/function c4
  fails) — likely overlaps #1130.

No code change landed under this task; needs architect spec before implementation.

## Partial fix #1629b (2026-05-28)

Sub-cluster fixed: `Object.getOwnPropertyDescriptor` attribute readback
for plain-object struct fields that were redefined via
`Object.defineProperty`. Root cause: the GOPD fast path in
`src/codegen/expressions/calls.ts` reads `ctx.shapePropFlags`, but that
table is built via `buildShapePropFlagsTable` *after* body compilation
finishes — so per-variable updates recorded during codegen
(`definedPropertyFlags`, keyed `varName:propName`) are overwritten with
defaults. The defineProperty path's attempt to update `shapePropFlags`
inline (object-ops.ts:1133-1137) is a no-op when the table has not yet
been created.

Fix: GOPD fast path now consults `ctx.definedPropertyFlags` first when
arg0 is an identifier, falling back to the shape table. Tests:
`tests/issue-1629b.test.ts` (4 cases: writable/enumerable/configurable
overrides + default preservation, all green). Does not address
sub-clusters #1629a (dynamic descriptor) or #1629c (Array/Function
exotic) — those remain open.

---

# Unified Implementation Plan — Object property-descriptor model

> Architect, 2026-05-29. Authoritative sequencing plan for the entire
> `Object.{defineProperty,defineProperties,create,getOwnPropertyDescriptor,
> getOwnPropertyDescriptors}` family plus Array/Function exotic
> `defineProperty`. Branch each slice off fresh `origin/main`. Read this
> top-to-bottom before claiming any slice — the slices share one model and
> must land in order S1→S6 (each gated on the prior to avoid regressions).

## Live baseline (results JSONL, HEAD `9ee8e921`, 2026-05-29)

| bucket | pass | fail | other | total | rate |
|--------|-----:|-----:|------:|------:|-----:|
| `Object/defineProperty`            | 497 | 623 | 11 | 1131 | 43.9% |
| `Object/defineProperties`          | 301 | 328 |  3 |  632 | 47.6% |
| `Object/create`                    | 169 | 146 |  5 |  320 | 52.8% |
| `Object/getOwnPropertyDescriptor`  | 266 |  43 |  1 |  310 | 85.8% |
| `Object/getOwnPropertyDescriptors` |   8 |   8 |  2 |   18 | 44.4% |
| **family total**                   | **1241** | **1148** | **22** | **2411** | 51.5% |

Plus the ~80-test `Array/prototype/*` getter-observing cluster (#1130,
`in-review`) which depends on the same accessor-read primitive S3 introduces.

Fail-prefix breakdown (non-pass only): `defineProperty:15.2.3.6-4` 427,
`defineProperty:15.2.3.6-3` 178, `defineProperties:15.2.3.7-6` 171,
`defineProperties:15.2.3.7-5` 146, `defineProperty:15.2.3.6-2` 8, rest <10.

Failure-mode histogram (sampled across the family, dominant first):
1. **`accessed !== true`** (~70) — `defineProperty(o,k,{get})` then `o.k`
   reads the struct field directly, the accessor never fires. *(read-back gap)*
2. **`overrideData` / data not overwritten** (~50) — dynamic data descriptor
   stored in the JS sidecar, but compiled `struct.get` reads the original
   field value. *(write-back gap)*
3. **`afterDeleted` / redefine-then-read** (~45) — same struct read-back gap
   after `delete` + redefine.
4. **`Expected TypeError, got "Expected an exception"`** (~60) — invariant
   not enforced: a non-configurable/non-writable redefine that must throw
   silently succeeds (the receiver is an exotic or the validation path is
   not reached for that receiver kind).
5. **`Getter/Setter must be a function: [object Object]`** (~16) — descriptor
   `get`/`set` arrives as a WasmGC closure struct, not a JS callable.
6. **`RangeError` on `length` redefine** (~3 named + within c4) — Array exotic
   `length` validation (ArraySetLength).

## Root cause (one model, three storage sites that disagree)

There are **three** places a property's value+attributes can live, and the
compiled read path only ever consults the first:

- **(a) the WasmGC struct field** — `struct.get`/`struct.set`. This is what
  compiled `o.k` reads/writes for a statically-typed plain-object receiver.
  It has *no* attribute storage; every field is implicitly
  `{writable,enumerable,configurable:true}` and is always a *data* property.
- **(b) the JS-side descriptor sidecar** — `_wasmPropDescs`
  (`src/runtime.ts:450`, per-object `Map<key,flags>` with bits
  `_SC_WRITABLE|_SC_ENUMERABLE|_SC_CONFIGURABLE|_SC_DEFINED|_SC_ACCESSOR`,
  defined at 763-767), the accessor store `_wasmStructAccessors` (457), and
  the value sidecar `_wasmStructProps`. Populated by the runtime
  `__defineProperty_*` helpers and read by host-side MOP operations
  (`getOwnPropertyDescriptor`, `Object.keys`, `JSON.stringify`, the
  `_wrapForHost` proxy traps).
- **(c) compile-time tables** — `ctx.definedPropertyFlags`
  (keyed `"varName:propName"`, set in `object-ops.ts`) and
  `ctx.shapePropFlags` (per-struct-type, built post-body). Used by the
  `getOwnPropertyDescriptor` / `propertyIsEnumerable` fast paths in
  `expressions/calls.ts`.

The runtime model (b) is already **substantially correct**: ToPropertyDescriptor
(`_toPropertyDescriptorValidate`, runtime.ts:851) and ValidateAndApply
(`_validatePropertyDescriptor`, runtime.ts:792) implement the ES §10.1.6.3
invariants, freeze/seal flips them correctly, and #1629a/#1629b/#1631 wired the
dynamic-descriptor and GOPD-read-back paths. **The unsolved problem is that
compiled code bypasses (b) entirely**: it reads/writes the struct field (a)
directly, so an accessor defined via `defineProperty` is invisible to a
subsequent compiled `o.k`, and a dynamic data write lands only in the sidecar
that compiled reads never consult. #1630 fixed the *write* direction for the
host→struct path (`__sset_` setters); the missing direction is **struct read →
descriptor model** when a property has a non-default descriptor.

## The unified descriptor model (target end-state)

**Single source of truth = the runtime sidecar (b), reached uniformly via a
`[[Get]]`/`[[Set]]`/`[[DefineOwnProperty]]` shim whenever a property is known
to carry a non-default descriptor.** Fast-path direct `struct.get`/`struct.set`
is *retained* for the overwhelmingly common case of a never-`defineProperty`'d
property (zero overhead, no regression). The model is the same in host mode and
standalone/WASI mode; only the *backing primitive* differs:

- **Host mode**: sidecar maps keyed on the JS object identity
  (`_wasmPropDescs`/`_wasmStructAccessors`/`_wasmStructProps`), exactly as
  today. Accessor invocation goes through `_maybeWrapCallable` so WasmGC
  closure get/set become JS callables.
- **Standalone/WASI mode** (no JS host): the same per-object descriptor table
  is a WasmGC structure attached to the object — `(type $DescEntry (struct
  (field $key (ref string)) (field $flags i32) (field $value (mut anyref))
  (field $get (mut anyref)) (field $set (mut anyref))))` held in a
  `(array (mut (ref null $DescEntry)))` reachable from the object via a
  side `WeakMap`-equivalent: a global `(array (mut (ref null any)))` keyed by a
  per-object monotonic id stored in a hidden i32 field, OR — simpler and
  preferred for S1 — a dedicated `$DescSidecar` field appended to the object
  struct, `null` until the first non-default define. Flags bit layout is
  identical to the runtime `_SC_*` constants so the two modes share the
  ValidateAndApply logic (port `_validatePropertyDescriptor` to a Wasm
  function in S5; until then standalone falls back to the host helper when a
  JS host is present and is documented-degraded otherwise).

The **distinction key** that decides fast-path vs shim is a per-(receiver,
property) "has-non-default-descriptor" bit:
- **Compile time**: `ctx.definedPropertyFlags` already records every property a
  given variable had `defineProperty` called on. Extend it to also record
  *accessor-ness* (it stores flags; add the `_SC_ACCESSOR` bit at the
  define site) so codegen can decide at the *read* site whether to emit the
  accessor-aware shim.
- **Runtime** (dynamic receiver / unknown at compile time): the sidecar's
  presence of an entry for the key *is* the bit. The shim checks
  `_wasmPropDescs.get(o)?.has(key)` (host) / `$DescSidecar != null` lookup
  (standalone) and only then diverges from the field.

This mirrors the existing **class-accessor** mechanism (`ctx.classAccessorSet`
+ `__<Struct>_get_<prop>` call in `property-access.ts:870-883`) — that is the
exact pattern S3 generalises from class-declared accessors to
`defineProperty`-declared ones.

**Coordination with #1726 arguments-exotic / `[[ParameterMap]]`**: there is no
`1726-*` file on disk yet. When it lands, its mapped-arguments model is a
*separate exotic* `[[DefineOwnProperty]]` (CreateMappedArgumentsObject, ES
§10.4.4) whose entries alias the formal-parameter slots. It must **reuse** the
S1 descriptor-sidecar storage and the S3 accessor-read shim, but install its
own per-index getter/setter pair (the parameter map) rather than the generic
data field. Do **not** fork a second descriptor representation — the arguments
exotic is a *producer* of sidecar accessor entries, consumed by the same shim.
Flag the dependency in #1726 when it is written; until then S1–S6 are
arguments-agnostic.

## Slice sequence (S1–S6) — each independently shippable, net ≥ 0

> Sequencing rule: S1 unifies storage, S2 the descriptor-read API, S3 the
> compiled read path (the big lever), S4 invariants, S5 Array/Function exotics
> (#1629c), S6 standalone parity. S3 depends on S1+S2; S5 depends on S4. Each
> slice carries its own `tests/issue-1629-S{n}.test.ts` and must show full-CI
> `net ≥ 0` with no single Object/Reflect bucket regressing > 0.

### S1 — Consolidate descriptor storage + GOPD/GOPDs read-back  *(est. +35–55)*

**Goal**: one canonical per-object descriptor table feeds *all* descriptor
read APIs; `getOwnPropertyDescriptor`/`getOwnPropertyDescriptors` return
spec-correct attributes for every define path (literal, dynamic, accessor).

**Files**: `src/runtime.ts`, `src/codegen/expressions/calls.ts`,
`src/codegen/object-ops.ts`.

- Make `getOwnPropertyDescriptors` (`Object/getOwnPropertyDescriptors`,
  8 fails) a thin loop over `ownKeys` + the existing single-key GOPD helper —
  it currently has no dedicated path. Emit/route to a runtime
  `__getOwnPropertyDescriptors(obj)` that returns a plain JS object mapping
  each own key to the descriptor object built by the existing GOPD logic.
- Unify the three compile-time/runtime read sources behind a single runtime
  reader `_readOwnDescriptor(obj, key) -> PropertyDescriptor | undefined` that
  checks, in order: accessor sidecar (`_wasmStructAccessors`) → value+flags
  sidecar (`_wasmPropDescs` + `_wasmStructProps`) → live struct field via
  `__sget_<key>` with default data flags. The existing GOPD fast path in
  `calls.ts` (consults `ctx.definedPropertyFlags`, see #1629b note above) stays
  as the compile-time shortcut; this is its runtime fallback for dynamic
  receivers.
- Ensure `defineProperty`'s inline-literal path *also* writes the sidecar
  entry (today it only updates `ctx.definedPropertyFlags`/`shapePropFlags`) so
  GOPD-via-runtime and GOPD-via-compile-time agree. The
  `priorExistingFlags`/`newFlags` computation in `object-ops.ts:1137-1180`
  already derives the right flags — additionally call the runtime
  `__record_desc(obj, key, flags, valueOrAccessor)` so (b) is populated.

**Edge cases**: Symbol keys (use `_normalizeDescKey`); a property defined then
`delete`d must drop its sidecar entry; GOPDs ordering = `[[OwnPropertyKeys]]`
order (integer-index ascending, then insertion-order strings, then symbols).

**Tests**: `getOwnPropertyDescriptors/*` (18), the `15.2.3.6-3-*` GOPD
read-back subset.

> **S1 STATUS — DONE (2026-05-29, dev-b).** Implemented in `src/runtime.ts`:
> the canonical `_readOwnDescriptor(obj, prop, exports)` reader (sidecar
> value/accessor → proto/static method allowlists → bare struct field via
> `__sget_<key>` with default data flags) and `_ownStructKeys(obj, exports)`
> own-key enumeration (mirrors `__getOwnPropertyNames` + `__getOwnPropertySymbols`;
> a host-proxy `Reflect.ownKeys` does **not** surface typed struct fields, so a
> dedicated enumerator is required). The single-key `__getOwnPropertyDescriptor`
> now delegates to `_readOwnDescriptor`, and `__object_getOwnPropertyDescriptors`
> is a loop over `_ownStructKeys` + `_readOwnDescriptor` (was: bare
> `Object.getOwnPropertyDescriptors(obj)`, which returned `{}` for WasmGC
> structs). Both forms now agree on bare fields, sidecar (defineProperty'd)
> data/accessor props, and class methods. Tests: `tests/issue-1629-S1.test.ts`.
>
> The inline-literal `__record_desc` bullet was **not needed for agreement**:
> `getOwnPropertyDescriptors` always routes through the runtime
> `_readOwnDescriptor` reader (never the compile-time `ctx.definedPropertyFlags`
> shortcut), and `defineProperty` already populates the `_wasmPropDescs` /
> `_wasmStructProps` sidecar that the reader consults — so single-key and plural
> read the same source. Two adjacent pre-existing defects observed and left to
> their owners (out of S1 scope): (1) compiled member *dot*-access into a
> struct-shaped descriptor result (`ds.a.value`) reads as a struct field rather
> than a host property — a codegen member-access issue, not descriptor
> read-back; bracket access and returning the whole object to the host both
> work; (2) module-top-level `defineProperty` runs in the wasm start function
> before `setExports`, so the dynamic-descriptor materialization throws
> (start-fn/exports timing, #1629a / #1320 family). S2/S3 remain open.

### S2 — ToPropertyDescriptor / descriptor-validation completeness  *(est. +25–40)*

**Goal**: `15.2.3.6-3-*` (ToPropertyDescriptor, 178 fails) and the
`15.2.3.7-5/6-*` defineProperties coalescing clusters pass. This is the
"descriptor *input* parsing" half; S1 was the "descriptor *output*" half.

> **S2 STATUS — partial DONE (2026-05-29, dev-b).** Landed in `src/runtime.ts`
> `__defineProperties`:
> 1. **Two-pass** per ES §20.1.2.3.1 — the struct-descsObj path now gathers
>    `ToPropertyDescriptor` for *all* keys (pass 1) before applying any via
>    DefinePropertyOrThrow (pass 2). A bad-shape descriptor on a later key now
>    aborts before earlier keys install (observable for primitive/bad-shape
>    descriptors: `property-description-must-be-an-object-not-*`). Note:
>    DefinePropertyOrThrow validation (e.g. non-configurable redefine) correctly
>    stays in-order in pass 2, so an earlier valid key *is* installed before a
>    later DefinePropertyOrThrow throws — that is spec-correct (V8 matches).
> 2. **wrap-callable wired** into both `_toPropertyDescriptorValidate` call sites
>    so struct closure get/set surface to the spec `typeof === "function"`
>    checks, matching the single-key `__defineProperty` handler.
> Tests: `tests/issue-1629-S2.test.ts`.
>
> **Gated on closure-readability (S3).** The value+get TypeError and bad-shape
> abort are NOT observable when the offending per-property descriptor is itself
> a WasmGC struct whose `get`/`set` is a Wasm closure (or whose `value` is a
> closure): `getField`/`__sget_` cannot read a closure out of an arbitrary
> struct field, so `_toPropertyDescriptorValidate` sees it as absent and the
> conflict can't fire. This is the same root as S1's `ds.a` dot-access gap and
> belongs to **S3** (accessor-aware compiled read/write path). The two-pass +
> wrap-callable structure is correct and will start surfacing those wins the
> moment S3 lands closure-field readability. The HasProperty-vs-Get
> trap-ordering bullet is also deferred to S3 (needs the same reader).

**Files**: `src/runtime.ts` (`_toPropertyDescriptorValidate`, 851;
`_validatePropertyDescriptor`, 792), `src/codegen/object-ops.ts`
(`compileObjectDefineProperties`, the dynamic fallback at ~2597).

- `_toPropertyDescriptorValidate` already covers the data/accessor-mix
  TypeError, getter/setter-must-be-callable, and field coalescing. Audit
  against ES §10.1.6.3 step-by-step for the residual `15.2.3.6-3` fails:
  - **HasProperty vs Get order** — the spec reads `enumerable`,
    `configurable`, `value`, `writable`, `get`, `set` in that fixed order,
    each guarded by HasProperty. When the descriptor is a *Proxy or exotic*,
    the trap-invocation count/order is observable. Route through the host
    `Object.getOwnPropertyDescriptor`-equivalent ordering for externref
    descriptors; for struct descriptors the `getField` closure order must
    match.
  - **`defineProperties` Properties coercion** — ToObject(Properties), then
    `[[OwnPropertyKeys]]` filtered to enumerable, building a *descriptor list*
    first and only *then* applying (ES §20.1.2.3 / 19.1.2.3.1
    ObjectDefineProperties: two-pass — gather all, validate all, then apply).
    The current `__defineProperties` path applies as it iterates; convert to
    gather-then-apply so a later-key validation TypeError doesn't leave
    earlier keys mutated.
- Wire the `wrapCallable` (`_maybeWrapCallable`) path #1629a added so struct
  closure get/set never surface the `[object Object]` callable error (16 fails,
  failure-mode 5).

**Edge cases**: descriptor with getter that throws (must propagate); Symbol
descriptor keys; `__proto__` as a data key (not prototype) in the descriptor.

**Tests**: `defineProperty/15.2.3.6-3-*`, `defineProperties/15.2.3.7-{5,6}-*`,
the `property-description-must-be-an-object-not-*` set.

### S3 — Accessor-aware compiled read/write path  *(est. +90–140, the big lever)*

**Goal**: a property carrying a non-default descriptor (accessor, or
dynamically-written data value) is read/written through the descriptor model
by *compiled* code, not the raw struct field. Kills failure-modes 1/2/3
(`accessed !== true`, `overrideData`, `afterDeleted`) — the largest cluster.
Also unblocks #1130 (Array getter-observing iteration shares this primitive).

**Files**: `src/codegen/property-access.ts` (`compilePropertyAccess` ~971,
`compileElementAccess`, the struct-field read at 884-915), the assignment
lowering in `src/codegen/expressions.ts`/`statements.ts`,
`src/codegen/object-ops.ts`.

- **Read site** (`o.k` / `o[k]`): at compile time, if
  `ctx.definedPropertyFlags` has an entry for `(receiverVar, k)` whose flags
  include `_SC_ACCESSOR`, OR the receiver type is `any`/externref/unknown,
  emit the **accessor-aware shim** instead of the bare `struct.get`:
  ```wasm
  ;; shim: prefer descriptor model when an entry exists, else fast field read
  local.get $obj
  <prop-as-externref>
  call $__get_via_descriptor      ;; runtime: returns sidecar accessor result
                                  ;; (invokes get()) / sidecar value / sentinel
  ;; if sentinel "no-entry": fall through to struct.get fast path
  ```
  Model on the **existing class-accessor dispatch** in
  `property-access.ts:870-883` (`ctx.classAccessorSet` + `__<Struct>_get_<p>`
  call) — generalise it from class-declared accessors to a
  `ctx.definedAccessorProps` set populated at the `defineProperty` site.
  Where the receiver is statically a known struct **with no recorded
  accessor/dynamic-descriptor for `k`**, keep the bare `struct.get`
  (zero-overhead fast path — this is the no-regression guarantee).
- **Runtime `__get_via_descriptor(obj, key)`**: host import that consults
  `_wasmStructAccessors` (invoke getter via `_maybeWrapCallable`), then
  `_wasmStructProps`/`_wasmPropDescs` value, then returns a distinguished
  "no-entry" sentinel (a private externref singleton) so the compiled fast
  path can branch. Symmetric `__set_via_descriptor(obj,key,val)` invokes a
  sidecar setter or honours non-writable (no-op / throw-in-strict).
- **Write site** (`o.k = v`): if `(receiverVar,k)` is accessor → call the
  setter via `__set_via_descriptor`; if it is a recorded non-writable data
  prop → strict-mode TypeError / sloppy no-op; else `struct.set` fast path
  *and* keep the sidecar value in sync (so a later GOPD/host read agrees) via
  the `__sset_` + `__record_desc` pair from S1/#1630.

**Edge cases**: getter that mutates `o` re-entrantly; accessor defined on the
*prototype* (must walk the chain — defer cross-prototype to #1364b, scope S3
to own-property accessors); `delete o.k` must clear `definedAccessorProps` and
the sidecar so the field fast-path resumes; element access `o[i]` with computed
key where `i` is a known accessor index.

**Risk**: this touches the property hot path. Mitigation: the shim is emitted
**only** when the compile-time descriptor table says the property is
non-default, or the receiver type is dynamic; the dense statically-typed
struct path is byte-identical to today. Add a micro-benchmark to
`benchmarks/` (struct field read in a tight loop) and confirm no codegen change
for the no-descriptor case (diff the emitted Wasm for a plain `{a:0}.a` read).

**Tests**: `defineProperty/15.2.3.6-4-*` plain-object subset (~the 188
function-free / 83 plain of c4), `tests/issue-1629-S3.test.ts`
(accessor read-back, dynamic data overwrite, delete-then-read). Re-run #1130
suite — expect incidental gains.

### S4 — Invariant enforcement on define (configurable/writable/extensible)  *(est. +40–70)*

**Goal**: `defineProperty`/`defineProperties` throw `TypeError` exactly when ES
§10.1.6.3 ValidateAndApplyPropertyDescriptor mandates (failure-mode 4,
`Expected TypeError, got "Expected an exception"`, ~60). The runtime
`_validatePropertyDescriptor` already implements this for the sidecar; the gap
is that it is **not consulted** when the receiver is a typed struct whose
property was never sidecar-recorded (so `existing === undefined` → "first
definition" → no validation).

**Files**: `src/runtime.ts` (`_validatePropertyDescriptor`, the
`__defineProperty_*` helpers), `src/codegen/object-ops.ts`.

- On **every** `defineProperty`, seed the sidecar with the property's *current*
  effective descriptor *before* validating, so a struct field that exists with
  default `{writable,enumerable,configurable:true}` is treated as an existing
  configurable data property (redefine OK), while a property previously made
  non-configurable via an earlier define correctly rejects. This requires S1's
  "inline-literal path also writes the sidecar" so the first define of a
  literal property is recorded.
- `preventExtensions`/`seal`/`freeze` already flip flags (runtime.ts:4726-4763).
  Add the **non-extensible new-property** rejection: defining a *new* key on a
  non-extensible object throws (currently the new-key path skips the check —
  see `nonExtensibleVars` guard in `object-ops.ts:1142`, extend to the runtime
  helper for dynamic receivers).
- Honour `Reflect.defineProperty` returning `false` (vs throwing) — same
  validation, different failure surface; ensure both call sites share
  `_validatePropertyDescriptor`.

**Edge cases**: SameValue for non-writable redefine with equal value (already
in `_validatePropertyDescriptor:839`); data↔accessor flip on non-configurable;
`writable:false` then `writable:false` again (idempotent, no throw).

**Tests**: `defineProperty/15.2.3.6-4-*` invariant subset, `freeze`/`seal`/
`preventExtensions` redefine-throws cases, `Reflect/defineProperty/*`.

### S5 — Array & Function exotic `defineProperty` (#1629c)  *(est. +120–180)*

**Goal**: ES §10.4.2 (Array exotic `[[DefineOwnProperty]]`) and §10.2.4
(Function `length`/`name` non-writable-configurable) semantics. ~156 array +
~33 function fails in c4. Depends on S4 (invariant engine) being in place.

**Files**: `src/runtime.ts`, `src/codegen/object-ops.ts`
(`maybeEmitVecLengthGrowth`, 159; the externref/array define path),
`src/codegen/array-methods.ts` (length read via [[Get]] for #1130 overlap).

- **Array `length` exotic** (ES §10.4.2.4 ArraySetLength):
  - `defineProperty(arr, "length", desc)` with a numeric value: ToUint32 must
    equal ToNumber (else `RangeError` — failure-mode 6); if new len < old,
    delete indices ≥ newLen *in descending order*, stopping (and setting len to
    last+1) if a non-configurable index blocks the truncation; `writable:false`
    makes `length` non-writable (subsequent index sets beyond it fail).
  - In host mode, real JS arrays already implement this — route
    `defineProperty(realArray, "length", ...)` straight to native
    `Object.defineProperty` (the `_isArray` branch). The bug is the compiler
    *intercepts* array receivers via `maybeEmitVecLengthGrowth` and the typed
    `__vec_*` path, which bypasses native length semantics. Fix: when the
    receiver is an array and the key is `"length"` or a canonical numeric
    index, prefer the runtime `__defineProperty_desc` → native path over the
    typed fast path; keep the typed fast path only for the
    grow-by-index-assignment common case where no descriptor attributes differ
    from default.
  - **Array index exotic**: defining index `P` ≥ length on a non-writable-length
    array → reject; defining a valid index updates length; an accessor on an
    index makes array methods observe it (this is the #1130 link — S3's
    accessor-read shim must apply to `arr[i]`).
- **Function exotics** (ES §10.2.4): `length` and `name` are
  `{writable:false, enumerable:false, configurable:true}`. `defineProperty(fn,
  "length", {value})` is allowed (configurable) but `writable:true` on a
  redefine without configurable-change rules apply. In host mode route function
  receivers to native `Object.defineProperty`; the gap is the compiler treating
  a compiled function (a WasmGC closure struct) as a plain struct — detect
  `_isCallable`/closure receivers in the define path and route to the runtime
  helper that operates on the host function wrapper.
- **Bound functions**: defer `[[BoundTargetFunction]]` length composition to the
  existing bound-function work (runtime.ts:6202) — scope S5 to plain
  function/array exotics.

**Edge cases**: `Object.defineProperty(arr, "0", {get})` then `arr.map(...)`
(needs S3 accessor-read on indices); sparse array length truncation with a
non-configurable hole; `arguments` exotic is **out of scope** (→ #1726, reuses
S1/S3, separate exotic).

**Risk**: highest-blast-radius slice (Array hot path + array-methods). Land
**after** S3/S4 so the accessor-read primitive and invariant engine exist.
Watch `Array/prototype/*` and `Array/length` buckets for regression; the
typed `__vec_*` fast path for plain dense arrays must stay byte-identical.

**Tests**: `defineProperty/15.2.3.6-4-*` array/function subset,
`defineProperty/redefine-length-*`, `Array/prototype/*` (#1130), `Function/*`
length/name prop-desc tests.

### S6 — Standalone/WASI descriptor parity  *(est. +0 test262, dual-mode debt)*

**Goal**: the descriptor model works without a JS host (per the dual-mode
architecture principle). No new test262 (the runner uses host mode) but
required so the feature is not host-only.

**Files**: `src/runtime.ts` (the helpers being ported), a new
`src/codegen/descriptor-runtime.ts` or additions to `object-ops.ts`.

- Implement the `$DescSidecar` WasmGC field + `(array (ref null $DescEntry))`
  table described in "The unified descriptor model" above, attached to
  object structs lazily.
- Port `_validatePropertyDescriptor` (pure flag logic, no host calls) to a
  Wasm function so S4 invariants hold standalone.
- `__get_via_descriptor`/`__set_via_descriptor`/`__record_desc` get
  Wasm-native bodies that read/write the WasmGC table; accessor get/set are
  `call_ref` on the stored closure refs.
- Until S6 lands, standalone mode degrades gracefully: define records flags but
  cannot invoke accessors without a host — document the gap in
  `docs/architecture/` and gate behind the existing nativeStrings/standalone
  detection.

**Tests**: extend `tests/equivalence/` standalone variants; add a
`--target wasi` smoke test compiling a `defineProperty({get})` program and
asserting the getter fires.

## Cross-cutting risks & guardrails (apply to every slice)

1. **Object hot path** — S3 is the danger. The accessor-read shim must be
   emitted *only* when the compile-time descriptor table flags the property as
   non-default, or the receiver is dynamic. Prove no-regression by diffing the
   emitted Wasm for a plain `{a:0}.a` read before/after; add a tight-loop
   struct-read micro-benchmark to `benchmarks/`.
2. **Full-CI net ≥ 0 per slice, mandatory.** Each PR runs full sharded
   test262; `dev-self-merge` gate: `net_per_test > 0`, no single
   `built-ins/Object/*` or `built-ins/Reflect/*` or `built-ins/Array/*` bucket
   regressing. S5 specifically watch `Array/prototype/*` and `Array/length`.
3. **Reflect parity** — `Reflect.{get,set,defineProperty,
   getOwnPropertyDescriptor,ownKeys}` share the same model; a slice that fixes
   `Object.X` must not diverge from `Reflect.X`. Add the matching Reflect test
   path to each slice's scoped check.
4. **Proxy interaction** — descriptor traps on a Proxy descriptor argument
   (S2) and Proxy receivers (deferred) — keep `_wrapForHost`/`_hostProxyReverse`
   semantics intact; do not let the sidecar shadow a Proxy trap.
5. **Symbol keys** — every storage/read site uses `_normalizeDescKey`; never
   stringify a Symbol into a template-literal export name (`__sget_`/`__sset_`
   are string-key only by construction — Symbols stay sidecar-only).
6. **Sidecar/field sync** — after S1 every define writes both the struct field
   (when applicable, via `__sset_`) and the sidecar (`__record_desc`); a read
   that consults one must agree with the other. The single canonical reader
   `_readOwnDescriptor` (S1) is the reconciliation point.

## Dependency order (for the tech lead)

```
S1 (storage + GOPD/GOPDs)  ──┐
S2 (ToPropertyDescriptor)  ──┼──> S3 (compiled accessor read/write)  ──┐
                              │                                         ├─> S5 (#1629c Array/Fn exotic)
                             S4 (invariant enforcement) ────────────────┘
S6 (standalone parity) depends on S1+S3+S4 (port to Wasm); no test262 gate.
```

S1 and S2 are parallelisable (different files mostly: S1 in calls.ts/runtime
GOPD, S2 in runtime ToPropertyDescriptor). S3 needs both. S4 can run alongside
S3 (different concern: validation vs read path) but must land before S5.
#1130 should be re-tested after S3 and likely closes as incidental.

## Aggregate estimate

Conservative sum of per-slice lower bounds ≈ **+310** family tests; optimistic
upper bounds ≈ **+525**, plus the ~80 #1130 Array-getter tests unblocked by S3.
The family has 1,148 current fails, so the plan targets roughly 30–45% of the
remaining gap landing across S1–S5 (the residual is cross-prototype descriptor
inheritance #1364b, Proxy receivers, and bound-function exotics, all separate
workstreams).
