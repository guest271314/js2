---
id: 3177
title: "standalone: TypedArrayConstructors internals + ctors — integer-indexed MOP internals, ctor arg protocols, from/of, per-ctor identity (356 gap tests)"
status: in-progress
assignee: ttraenkler/sendev-1102
created: 2026-07-12
updated: 2026-07-16
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: typedarray
goal: standalone
umbrella: 2860
sprint: current
horizon: l
related: [2860, 2872, 2893, 2901, 3057, 3027]
origin: "PO groom of #2860 umbrella, 2026-07-12 lane-baseline diff; the 'TypedArray internals ~350' slice recommended by the #3027 triage"
# loc-budget-allow (#3177 slice 1): small in-place extensions of the
# subsystems that own these mechanisms — dataview-native gains the
# $__ta_ctor singleton registrar + the inline OOB-read undefined fix
# (+ 5 export keywords for the shared codec helpers ta-dyn-mop.ts imports);
# property-access-dispatch gains the <TA>.prototype.constructor static arm.
# The bulk of the new code lives in the NEW file src/codegen/ta-dyn-mop.ts.
# index.ts: +6 — one import + the fillTaDynViewMopArms(ctx) call, which MUST
# sit in the barrel's finalize sequence (ordering vs the other fills is
# load-bearing); the implementation itself is in the new module.
loc-budget-allow:
  - src/codegen/dataview-native.ts
  - src/codegen/property-access-dispatch.ts
  - src/codegen/index.ts
---

# #3177 — standalone: TypedArrayConstructors internals + constructor protocols

## Implementation Plan (sendev-1102, 2026-07-16 — verified against live probes on main)

Full-directory standalone sweep (736 files): 127 pass / 544 fail / 65 CE.
Signature clusters: 289 wrong-value asserts (dominated by missing observable
throws + identity), 144 `Cannot access property on null or undefined`, 47 CE
`Reflect.construct` (#1472 Phase C), 19 vacuous-callback, ~50 illegal-cast
throw-path closures, 10 CE `BigInt64/BigUint64Array.prototype` static read.

Verified mechanism gaps (probe `.tmp/probe-3177-mop5.mts`, all on main):
construction/element-get/`Reflect.has`/`length`/OOB-set-noop WORK on dynamic
views; BROKEN: `.constructor` identity both directions, `sample["1.1"]`
canonical-key interception, `Object.keys`, defineProperty expandos,
`delete` result, `.buffer` (undefined → every `$DETACHBUFFER` test dead).

Explorer-verified substrate (2026-07-16):

- ALL seven standalone MOP natives (`__extern_get`/`__extern_set`/
  `__extern_has`/`__delete_property`/`__reflect_set`/`__object_keys`/
  `__defineProperty_*`) gate on `ref.test $Object` only — zero
  `$__ta_dyn_view` arms. GOPD's call-site guard THROWS on non-$Object.
- `$__ta_dyn_view = {length mut i32, buf ref null $__vec_i32_byte,
byteOffset i32, kind i32}` subtypes `$__vec_base`; detach = `buf.length`
  forced to −1 (`IsDetachedBuffer` ≡ `buf==null || buf.length<0`); bounds
  helpers already floor to 0 on detach.
- `emitTaCtorValue` (bare `Uint8Array` in value position) does `struct.new`
  PER SITE — `taCtorSingletonGlobals` (#3054 D) is initialized but NEVER
  consumed, so ctor identity is broken at the root (`ref.eq` fails between
  two mentions of the same ctor).
- `%TypedArray%` intrinsic ctor object exists (#2901) but there is NO
  per-view ctor-as-value identity, no `.constructor` on the proto glue
  (excluded from `TYPED_ARRAY_PROTO_METHODS`), and TA names are absent from
  `BUILTIN_CONSTRUCTOR_IDENTITY_NAMES` (#3006 arm).
- `.buffer` on views is a hard refusal (`emitProtoMemberBodyRefusal`,
  array-object-proto.ts ~1377; the "PR-3" residual of #2901). Buffer-backed
  views carry the backing vec ref → identity is free once read.
- Finalize-time arm precedent: `fillDynamicForinVecArms` (#3183) prepends
  `ref.test`-guarded arms into the natives; `__str_to_number` +
  `number_toString` exist for canonical-numeric-key work.

### Work packages (this PR)

- **W1 identity**: (a) make `$__ta_ctor` per-kind SINGLETON module-globals
  (immutable global with `struct.new` const initializer; `emitTaCtorValue`
  → `global.get`) — identity by construction everywhere; (b) static arm
  `<TA>.prototype.constructor` → singleton (parallel to the
  property-access-dispatch.ts:294 `%TypedArray%` arm); (c) `.constructor`
  on statically-typed view receivers via TA names in the #3006-style arm;
  (d) runtime `.constructor` for any-typed dyn-view receivers inside the
  `__extern_get` dyn-view arm (kind → singleton global switch).
- **W2 integer-indexed MOP arms** (§10.4.5), PREPENDED before the generic
  `$__vec_base` arms (dyn-view subtypes it — must intercept first):
  factor `__ta_dyn_valid_index(view,f64)->i32` (IsValidIntegerIndex:
  integral, 0≤i<effectiveLen, not detached) + reuse the runtime-kind codec
  for `__ta_dyn_get_elem`/`__ta_dyn_set_elem`; add dyn-view arms to
  `__extern_get`/`__extern_has` (canonical-numeric string key via
  `__str_to_number`+`number_toString` round-trip = CanonicalNumericIndexString),
  `__extern_get_idx`/`__extern_has_idx`/`__extern_set`/`__reflect_set`,
  `__delete_property` (index: valid→false-but-configurable-per-ES2021…
  actually [[Delete]] canonical→ IsValidIntegerIndex? false : true),
  `__object_keys` (indices 0..len−1 + expando keys), `__defineProperty_*`
  (canonical index → validate + write element; else expando), GOPD call-site
  (dyn-view + canonical index → data descriptor {value, writable:true,
  enumerable:true, configurable:true}).
  Expando bag: append `expando: mut (ref null $Object)` field to
  `$__ta_dyn_view` (update every `struct.new` site in dataview-native.ts;
  append-only field keeps existing field indices and the `$__vec_base`
  subtype prefix valid); non-canonical keys delegate Ordinary\* to the
  expando `$Object` (lazily created on first define/set).
- **W3 `.buffer` dynamic arm**: dyn-view receiver → `struct.get buf` boxed
  externref (identity + detach observability for `$DETACHBUFFER`);
  plus `byteOffset` runtime arm if missing (byteLength exists, #3054 C).

### Slice 1 — LANDED (PR: this branch, 2026-07-16)

Directory sweep (all 736 files, standalone): 127 → **156 pass (+29), 0
regressions**; the arms are generic (any Reflect/bracket/keys/delete on a
dyn-view anywhere), so cross-directory gains land in full CI.

What landed:

- W1 identity: `$__ta_ctor` per-kind singleton globals (`emitTaCtorValue` →
  `global.get`; `getOrRegisterTaCtorSingleton` in dataview-native.ts);
  `<TA>.prototype.constructor` static arm (property-access-dispatch.ts,
  #3006-parallel, declaration-file-gated — TA builtins are interface+var,
  not classes, so `isExternalDeclaredClass` can't be the gate); runtime
  `.constructor` on dyn-views via the [[Get]] arm's kind→singleton switch.
- W2 MOP arms: NEW `src/codegen/ta-dyn-mop.ts` — `__ta_dyn_get_elem` /
  `__ta_dyn_set_elem` / `__ta_dyn_has_idx` natives (synthetic-fctx #2872
  pattern, reusing the #3057 byte codec) + `fillTaDynViewMopArms` finalize
  fill prepending dyn-view arms into `__extern_get`/`__extern_has`/
  `__extern_set`/`__reflect_set`/`__delete_property`/`__object_keys`/
  `__extern_get_idx`/`__extern_has_idx`. CanonicalNumericIndexString =
  `__str_to_number`→`number_toString` round-trip + "-0" literal (exact
  §7.1.21); IsValidIntegerIndex = integral ∧ ¬-0 ∧ (u32)i<len (detach
  floors len to 0 via the buf.length=-1 sentinel — OOB covers detached).
  Value ToNumber uses `__unbox_number` (finalize-safe DEFINED func — no
  import add / funcIdx shift at finalize).
- W3: `buffer`/`byteLength`/`byteOffset`/`BYTES_PER_ELEMENT`/`length` named
  props in the [[Get]]/[[Has]] arms — `.buffer` returns the SAME backing
  byte-vec ref (ArrayBuffer IS the bare `$__vec_i32_byte`), so
  `ta.buffer === buffer` identity holds and `$DETACHBUFFER` works on
  harness-shaped receivers.
- Fix: inline dyn-view OOB element read returns the `undefined` singleton
  (was `ref.null.extern` → `ta[oob] === undefined` was false).

Verified: tests/issue-3177.test.ts (19), scoped suites 2872/2186/2190/3054\*/
3057/3058/3169/3183/3190 — failures identical to clean main (4 pre-existing
issue-3183 rows fail on main HEAD too; noted for triage, unrelated).

### Remaining (next slices — release+reclaim per phase)

- **Ctor-arg protocol throws** (~60–90 rows, `ctors/buffer-arg` +
  `length-arg`): ToIndex RangeError on offset/length, offset%elemSize
  RangeError, Symbol-offset TypeError, detached-at-construction TypeError,
  `Object.getPrototypeOf(ta) === TA.prototype` — extend
  `emitDynamicTaViewConstruct` / `emitTaDynCtorConstructFromLocals`
  (dataview-native.ts ~3296/~3494). Also the static literal `new TA(len)`
  ToIndex asymmetry (explore finding — no validation at all).
- **Descriptor MOP arms** (~70 rows, `internals/DefineOwnProperty` +
  `GetOwnProperty`): dyn-view arms in `__defineProperty_*` + the GOPD
  call-site guard — COORDINATE with in-flight #2984 (builtin-descriptor
  MOP owner).
- **Expando side-table**: non-index own props on views
  (`Object.defineProperty(sample, "bar", …)` + delete-configurability) —
  needs an `expando (mut ref null $Object)` field appended to
  `$__ta_dyn_view` (append-only keeps `$__vec_base` prefix valid).
- **BigInt kinds** (~150 rows, everything `*-bigint`/`BigInt`): BigInt64/
  BigUint64 need i64 elements + ToBigInt — gated on the #1349/#1644
  i64-brand ValType decision; NOT schedulable until that ADR lands.
- **from/of statics** (~50 non-bigint rows) — on the intrinsic ctor
  objects (#2901).
- **Reflect.construct standalone** (47 CE) — #1472 Phase C class;
  `custom-proto-access-throws` observability depends on it.
- Vacuous harness-callback residue (~19, #2940 class);
  `Reflect.set` with explicit receiver CE (8).

### Deferred to follow-ons (file at PR time)

- `Reflect.construct` standalone (47 CE) + `custom-proto-access-throws`
  observability; `%TypedArray%.from/of` statics (75 fails); true
  iterable-protocol ctor arm; static literal `new TA(len)` ToIndex
  validation asymmetry (explore finding); BigInt64/BigUint64
  `.prototype` static-read CE (10); vacuous-callback residue (#2940 class).

### Hazards

- Type-index stability: register new natives/fields late+once (memory
  `project_type_index_shift_and_deadelim`, `reference_subview_type_idx_stability`).
- Never alias one Instr[] into two arms (`reference_shared_instr_object_dce_double_remap`).
- Broad-impact class: `Int8Array`-as-value / MOP natives are wide — validate
  via full CI + merge_group, not scoped sweeps
  (`project_broad_impact_validate_full_ci`); standalone floor only on
  merge_group.
- #2872 owns `built-ins/TypedArray/prototype/` arms — its branch tip is
  already an ancestor of main (no unlanded divergence, verified 2026-07-16);
  shared dyn-view plumbing edits are additive prepended arms only.

## Problem

**356 host-pass tests are not host-free-standalone passes** under
`built-ins/TypedArrayConstructors/` (331 fail + 25 CE; measured 2026-07-12
lane-baseline diff, method in #3169). This is the "TypedArray internals ~350
— next-largest single slice" follow-on the #3027 triage recommended, distinct
from the in-flight #2872 (which owns `built-ins/TypedArray/prototype/` — do
NOT touch those paths here; coordinate with the #2872 owner on shared view
plumbing).

Breakdown: `internals/` 115 (HasProperty/Get/Set/DefineOwnProperty/Delete/
OwnPropertyKeys over integer-indexed receivers, mostly detached-buffer +
non-numeric-key arms), `ctors-bigint/` 57 + `ctors/` 53 (buffer-arg /
object-arg / length-arg constructor protocols: `custom-proto-access-throws`,
iterator-vs-arraylike, `ToIndex` on length/offset, species/newTarget proto
lookup), `from/` 35 + `of/` 18 (statics over the intrinsic ctor objects
from #2901), `prototype/` 30 + per-ctor identity rows
(`Uint16Array/prototype/constructor.js`-style
`Object.getPrototypeOf(...)`/`.constructor` asserts).

Measured signatures: `TypeError: Cannot access property on null or undefined`
(30+, the internals arms fall off the dynamic reader), `illegal cast [in
__closure_N ← assert_throws …]` (17+, throw-path closures over the view),
`Object method called on null or undefined`, destructure-null, and plain
wrong-value asserts on prototype identity.

## ANTI-BLOAT directive

- The substrate EXISTS and this slice must compose it, not fork it:
  - `$__ta_dyn_view` + runtime-kind element codec (#3057,
    `src/codegen/array-methods.ts` `emitTaDynViewToVec`) for the
    integer-indexed `[[Get]]/[[Set]]/[[HasProperty]]` arms — extend the codec
    arms with the detached-buffer + canonical-numeric-key spec steps
    (`internals/*/detached-buffer-key-is-not-number.js` etc.).
  - the distinct view brand (#2893) for receiver checks.
  - the intrinsic ctor objects + getPrototypeOf chain (#2901) for identity,
    `from`/`of` statics, and `custom-proto-access-throws` (newTarget
    `.prototype` Get must be observable/throwing).
  - descriptor arms via the builtin-descriptor MOP lineage (#2984/#2965) —
    table/arms extensions, not a parallel descriptor path.
- BigInt ctors coerce via `ToBigInt`; the 25 CE rows are compile-time
  refusals that should route into the same dynamic-view arms rather than CE.

## Acceptance criteria

- ≥240 of the 356 measured gap tests under
  `built-ins/TypedArrayConstructors/` flip to host-free standalone passes.
- Sample tests:
  - `test/built-ins/TypedArrayConstructors/internals/HasProperty/detached-buffer-key-is-not-number.js`
  - `test/built-ins/TypedArrayConstructors/ctors/buffer-arg/custom-proto-access-throws.js`
  - `test/built-ins/TypedArrayConstructors/Uint16Array/prototype/constructor.js`
- Zero host-mode regressions; zero standalone high-water regressions; no
  edits under the `built-ins/TypedArray/prototype/`-serving method arms
  without syncing with #2872's owner.
- Horizon L: if the internals arms + ctor protocols land but `from`/`of`
  residual >50 tests remains, split a follow-on instead of one mega-PR.
