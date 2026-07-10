---
id: 2984
title: "Standalone gOPD-on-builtin descriptor MOP (~178: getOwnPropertyDescriptor on builtin objects / proto receivers)"
status: in-progress
sprint: current
priority: high
horizon: xl
feasibility: hard
area: codegen, runtime
goal: standalone-mode
related: [2965, 2861, 2863, 2896, 2949, 2989]
origin: "#2965 descriptor-cluster triage — follow-up class 1"
assignee: ttraenkler/fable-2984
---

# #2984 — standalone gOPD-on-builtin descriptor MOP

## Slice 1 LANDED (2026-07-10, fable-2984) — the cluster's keystone was a boolean-typed dynamic-read bug, not the descriptor MOP

> Re-measured against `origin/main` @ `cd9f2cfbfd` through the REAL runner
> (`runTest262File`, standalone lane). Cluster state on the two directories
> `built-ins/Object/getOwnPropertyDescriptor{,s}` (328 tests): **78 pass /
> 178 fail / 72 CE**. The dominant failure was NOT a missing descriptor — it
> was that descriptor-attribute ASSERTS fail even when the descriptor is
> perfect.

### Root cause (measured, WAT-verified)

`assert.sameValue(desc.writable, true)` lowers `desc.writable` (lib type
`boolean | undefined`) through `compilePropertyAccess`'s dynamic fallback:
`__extern_get(desc, "writable")` → **`__unbox_number` + `i32.trunc_sat_f64_s`**
(a ToNumber, not a boolean read) → i32 → the any-context arg consumer re-boxes
via **`__box_number`**. The standalone native `__unbox_number` yields NaN for a
boxed boolean → i32 0 → boxed NUMBER 0 → `0 === true` fails for EVERY
attribute assertion, on every receiver (plain objects included). The host lane
only "passed" the harness shape by a double coincidence (host ToNumber(true)=1,
then a numeric compare); the local-bound shape `var w = desc.writable; typeof w`
was `"undefined"` on BOTH lanes. Three probe shapes pinned it:
inline `desc.writable === true` passed (different arm), computed-key
`desc["writable"]` passed (dynamic all the way), only the checker-typed
narrowing path broke.

### Fix (PR: `issue-2984-gopd-builtin-mop`)

`src/codegen/property-access.ts`: in the dynamic-fallback region of
`compilePropertyAccess`, a **boolean-like access type keeps the raw externref**
(no i32 narrowing through the numeric unbox pipeline). New helper
`isBooleanLikeAccessType` walks union members (`boolean | undefined` carries no
`BooleanLike` flag on the union object itself — that was the first-attempt
trap). Preserves both the boolean box (value-correct native `===`) and
`undefined` for absent attributes (the i32 path erased absent → `false`).
Numeric narrowing and the Phase-3 struct-candidate narrowing are untouched, so
modules without boolean-typed dynamic-fallback reads are byte-identical.

### Measured effect (real runner, standalone lane)

| Directory | before | after | Δ |
| --- | --- | --- | --- |
| `built-ins/Object/getOwnPropertyDescriptor{,s}` | 78 pass | **119 pass** | **+41, 0 regressions** |
| `built-ins/Object/defineProperty` | 502 pass | **534 pass** | **+32, 0 regressions** |

Host lane on the gOPD dirs: 301/328 before AND after (unchanged). The fix
radiates suite-wide: every standalone test asserting a boolean property through
a harness `assert.sameValue`/param was affected, so expect flips well beyond
these directories (propertyHelper/verifyProperty clusters).

### Remaining buckets (re-scoped 2026-07-10; the follow-up slices)

After slice 1, the two gOPD dirs still have 137 fail / 72 CE:

1. **~72 CE — ctor/namespace receivers** (`gOPD(String, "fromCharCode")`,
   `gOPD(Array, "isArray")`, `gOPD(Math, "max")`, `gOPD(Object, "keys")`):
   still the `__get_builtin` refusal from the dynamic-fallback routing in
   `calls.ts`. Needs a Site-2-style synthesis for builtin-CTOR receivers
   backed by a static-property descriptor table + first-class static-method
   closures (`ensureStandaloneBuiltinStaticMethodClosure` covers only ~8
   statics today). Biggest single remaining bucket.
2. **~124 fail — undefined descriptor for un-reified receivers**: by receiver:
   `Date.prototype` (44), `String.prototype` members not in the glue CSV (16),
   global-object receivers `this`/`global` (11), `Object.prototype` (7),
   `Number.prototype` (7), `Function.prototype` (5), `Boolean.prototype` (3),
   Error-family protos (~6), plus misc `obj`-var receivers (17). Fix =
   extend the #2885 Site-2 synthesis + `NativeProtoBuiltinGlue` member tables
   to these builtins/members. Mechanical per-family work once the closure
   refusal bodies exist (the #2193/#2651 degrade-to-catchable pattern).
3. **gOPDs (plural) residuals**: `Object.getOwnPropertyDescriptors(Array.prototype)`
   returns an object with no `forEach` entry (needs the same proto reification);
   plain-object gOPDs now passes its attribute asserts after slice 1.
4. Bucket-1 note: `gOPD(Array.prototype, "forEach")` on current main already
   returns identity-correct `.value` (`d.value === Array.prototype.forEach`
   passes — #2175 V2-S2 singletons). Only INVOKING the extracted value still
   fails (blocked on #2949 method-value reification, as documented below).

## Problem

Follow-up from #2965 (descriptor cluster). `getOwnPropertyDescriptor` on a
builtin object or a builtin **prototype/constructor** receiver has no
meta-object protocol on the standalone lane, so the dynamic
`__getOwnPropertyDescriptor` native either returns `undefined` or hard-CEs.
Subsequent `.value`/attribute reads then throw or the compile fails outright.
~178 tests across the descriptor cluster hinge on this. It is the substrate
gap that **co-blocks #2989** (dynamic-descriptor `defineProperty` spec
TypeErrors landed there, but the reachable test262 assertions that would flip
run gOPD-readback first, so #2989 measures net-0 until this lands).

This is design-only — no implementation in this issue. It is a **spec seed**
to size the work and record why the existing machinery does not extend.

## Measured current-main state (2026-07-03, sr-gopd) — the narrative below is STALE

> **Re-measured against `origin/main` @ `bc8a1d4ca` (`target: standalone`,
> instantiate with empty imports `{}`).** Current main has **advanced past**
> the "returns `undefined` / drops the accessor" narrative in the original
> buckets below (which was written against an earlier tree, pre
> #2861/#2863/#2896). The buckets are still the right decomposition, but the
> _actual remaining gap in each_ is narrower and different from what the
> original text says. **Read this section as the authoritative status; the
> three-bucket text underneath is the historical seed.** Probes: `.tmp/probe*.mjs`
> (gitignored) — reproduce with `compile(src, {target:'standalone'})` then
> `WebAssembly.instantiate(r.binary, {})`.

| Bucket | Original narrative | **Measured on current main** |
| --- | --- | --- |
| **(1) proto-receiver** `gOPD(Array.prototype,"forEach")` | returns `undefined` | **No longer `undefined`.** Returns a descriptor with **correct boolean attributes** (`writable:true, enumerable:false, configurable:true`) and a `.value` slot that is present but **broken**: `typeof d.value` is **codegen-path-dependent** (`"function"` when tested inline, `"object"` when bound to a `const` first — representation instability), the value is **non-invocable** (`d.value.call(arr, cb)` is a no-op / traps — `arr` unchanged), and **non-canonical** (`d.value !== Array.prototype.forEach`). Gap narrowed from "no descriptor" to "**`.value` is a non-first-class placeholder**". |
| **(2) ctor-receiver** `gOPD(Array,"isArray")` | hard-CE `__get_builtin not yet supported` | **UNCHANGED** — still hard-CEs with `Codegen error: '__get_builtin' (dynamic-shape object/property operation) is not yet supported in --target standalone (#1472 Phase B)`. The refusal **string** is emitted by the generic refused-late-import path at `src/codegen/expressions/late-imports.ts:99`; the **routing** that reaches it (a builtin constructor used as a _dynamic_ gOPD receiver falling through to the `__get_builtin` shortcut) is in `src/codegen/property-access.ts` (the `__get_builtin` branch, see the refusal-context comments ~L192–208 / L403). |
| **(3) plain-object accessor** `gOPD({get x(){…}}, "x")` | "returns a data descriptor / drops the accessor" | **Descriptor SHAPE is now correct**: `get`/`set` present, no own `value` (`hasOwnProperty("value")` false), `hasOwnProperty("get")` true, `enumerable`/`configurable` correct. **But INVOKING the accessor from the descriptor is not host-free**: `d.get()` pulls `env::WeakMap_get`, `d.set(v)` pulls `env::WeakMap_set` → **traps at instantiate under standalone** (missing import). A get+set literal (`{get x(){}, set x(v){}}`) also drags a `WeakMap` import even for the existence check on some shapes. Gap moved from "drops accessor" to "**accessor-closure invocation is not host-free**". |

### Shared root cause, confirmed by direct measurement

`Array.prototype.forEach` is **not a first-class invocable value** in
standalone _even outside gOPD_: binding `const fn = Array.prototype.forEach;`
gives `typeof fn === "function"` but `fn.call([1,2,3], cb)` **traps**
(`WebAssembly.Exception`). So the gOPD `.value` placeholder is not a
descriptor-path bug — it inherits the substrate fact that **builtin methods
are lowered inline-at-callsite and never materialise as callable funcref/closure
values**. This is exactly step (2) of "Rough shape of a real fix" below, and the
**D1 type-erased-value-representation** class (#2949's `dynamic` kind). No
descriptor-layer patch can fix bucket (1)/(2) without it.

### Re-scoping consequence — the ~178 estimate is likely an over-count now

The original ~178 assumed every bucket-(1) test fails on an `undefined`
descriptor. Since the **boolean-attribute assertions now pass** (the common
`verifyProperty`/`propertyHelper.js` shape checks that only assert
`writable`/`enumerable`/`configurable` + `typeof value === "function"`), a
material fraction of bucket (1) may **already pass** on current main. The
**residual** bucket-(1) failures are only the tests that (a) _call_
`descriptor.value`, or (b) assert `descriptor.value === Ctor.prototype.method`
identity, or (c) trip the `typeof` instability. **Next owner must re-measure the
real count** (run `built-ins/*/getOwnPropertyDescriptor` +
`built-ins/Object/getOwnPropertyDescriptor` through the real test262 harness on
standalone) before committing the XL sizing — the sub-3-attr-only tests are
sunk, and the true remaining number is probably well under 178.

### Recommended split (updated)

1. **Bucket (3) is the cleanest independent slice and has moved closest to
   done.** Its only remaining gap is a narrow, well-scoped one: make accessor
   get/set **closures host-free** (retire the `WeakMap_get`/`WeakMap_set` host
   import that accessor-closure storage/invocation drags in under standalone —
   see `src/codegen/accessor-driver.ts` + the `__call_accessor_get/set` drivers
   in `object-runtime.ts` ~L1020/L1558). This does **not** need the
   method-value reification substrate and could be its own S/M issue. Split it
   out and prioritise it — highest test-flip-per-effort of the three.
2. **Buckets (1) + (2) remain jointly blocked on method-value reification**
   (issue step 2), which should sit on **#2949's `dynamic` JsTag-carrying kind**
   rather than a parallel boxing scheme. Do **not** start (1)/(2) before #2949's
   substrate lands — a descriptor-layer-only attempt re-breeds the placeholder
   `.value` (and the `typeof` instability) rather than fixing it.
3. **Secondary bug to file separately:** the `typeof d.value` codegen-path
   dependence (inline `"function"` vs const-bound `"object"`) is a
   representation-stability defect in how an open-object descriptor field is
   read back; worth isolating even before (1) lands because it can cause
   flaky `typeof` assertions elsewhere.

**Verdict for this pass:** no small, self-contained code change flips any
test262 assertion without the method-value reification substrate. Per the
"banked spec beats a broken codegen change" discipline, this pass delivers the
measurement-grounded re-scope + split recommendation rather than a codegen
edit. Bucket (3)'s host-free-accessor slice is the recommended next
_implementable_ unit and is the only one that does not wait on #2949.

### Bucket (3) re-measurement (2026-07-03, dev-2984-bucket3) — the WeakMap narrative is STALE; bucket (3) is effectively DONE for test262

> **Re-measured against `upstream/main` @ `ab130543e`** (`target: standalone`,
> instantiate with empty imports `{}`). This slice was dispatched to "retire the
> `WeakMap_get`/`WeakMap_set` host import that accessor-closure invocation drags
> in". **That import leak no longer reproduces on current main** — the split
> recommendation above (item 1) is superseded by the findings here. Probes:
> `.tmp/probe*.mjs` (gitignored) — `compile(src,{target:'standalone'})` then
> `WebAssembly.instantiate(r.binary,{})` + `WebAssembly.Module.imports(mod)`.

**Finding 1 — no WeakMap import; the module is fully host-free.** `gOPD(obj,'x')`
on a plain object with `get x()`/`set x(v)` compiles with **zero imports**
(`WebAssembly.Module.imports` is empty). There is **no `env::WeakMap_get` /
`env::WeakMap_set`** — those symbols do not exist anywhere in `src/` on current
main (`grep -rn 'WeakMap_get\|WeakMap_set' src/` → 0 hits). The "traps at
instantiate under standalone (missing import)" narrative in the table above is
against a pre-#2861/#2863/#2896 tree and no longer holds.

**Finding 2 — descriptor SHAPE + accessor-closure STORAGE are correct.** All the
shape assertions that real test262 gOPD tests make pass host-free:
`typeof d.get === 'function'` ✓, `typeof d.set === 'function'` ✓,
`d.hasOwnProperty('value') === false` ✓, `d.enumerable === true` ✓,
`d.configurable === true` ✓. Direct accessor use also works: `obj.x` → `5`,
`obj.x = 42; obj._x` → `42` (the `__extern_get`/`__extern_set` arms invoke the
stored `$get`/`$set` closure via the `__call_accessor_get/set` drivers, threading
`this` through `__current_this` — all native, no host).

**Finding 3 — the residual gap is NOT accessor-specific and has ~zero test262
yield.** The only thing that fails is *invoking the getter/setter as a
first-class value pulled from the descriptor*: `d.get.call(obj)` → `0` (should be
`5`), `d.get()` → traps. But this is a **general `Function.prototype.call`/
`.apply`-on-a-first-class-closure-value** gap, not a descriptor/accessor bug — it
reproduces with no descriptor at all:

| probe (`--target standalone`) | result | expected |
| --- | --- | --- |
| `const m = o.m; m.call(o)` (method value, no `this`) | `0` | `5` |
| `const m = o.m; m.call(o)` (method reads `this._x`) | `0` | `9` |
| `const m = o.m; m.apply(o,[])` | `0` | `9` |
| `const g = h; g.call(null)` (fn-decl value) | `0` | `7` |
| `const m = o.m; m()` (direct, no `.call`) | `5` | `5` ✓ |
| `const f = () => 5; f.call(null)` (arrow value) | `5` | `5` ✓ |

Root cause: the `identifier.call(thisArg, …)` handler in
`src/codegen/expressions/calls.ts` (~L4831-4838) statically resolves the closure
and **drops `thisArg`**, treating every non-`$NativeProto` closure as
`this`-ignoring; a receiver-extracted method / descriptor getter never gets its
`this`. The `d.get.call(obj)` form is a *property-access* callee (not an
identifier), so it doesn't even reach that arm — it falls through the generic
closure-value dispatch, which has no path to recover the closure struct from an
arbitrary `externref` and re-invoke it through `__call_fn_method_0/1` with
`thisArg` bound. A correct fix is "route `.call`/`.apply` on a first-class
closure value through the `__call_fn_method_N(thisArg, closure, …args)`
dispatcher" — the **same method-value reification substrate that blocks buckets
(1)+(2)** (D1 / #2949), *not* an independent accessor slice.

**Finding 4 — no test262 gOPD test invokes the returned accessor.** In
`test262/test/built-ins/Object/getOwnPropertyDescriptor/`, **zero** tests call
`.get()`/`.set()`/`.get.call(…)` on the returned descriptor
(`grep -rlE '\.get\.call|\.set\.call|desc\.get\(|\bget\(\)'` → 0). They assert
descriptor *shape* only — which already passes (Finding 2). So the residual
"invoke accessor host-free" work flips ≈0 test262 assertions here.

**Corrected verdict for bucket (3):** it is **effectively done** for
test262-conformance purposes on current main (shape correct + host-free). The
"cleanest independent slice / highest test-flip-per-effort" framing in item 1 of
the split above is **wrong on current main** — that slice's only residual gap is
a general `.call`/`.apply`-on-closure-value substrate issue with near-zero
conformance yield, and its real fix converges with the #2949 method-value
reification that buckets (1)+(2) need. **Recommendation: do NOT spin bucket (3)
out as a standalone S/M issue.** Fold any remaining first-class-closure-invoke
work into the #2949 substrate track, and treat the accessor descriptor readback
itself as closed. (No codegen edit is delivered in this pass — a `.call`/`.apply`
drop-`thisArg` change risks regressing the many standalone tests that rely on
"standalone functions ignore `this`", and the correct dispatch belongs on the
#2949 substrate; per "banked measurement beats a risky codegen change" this pass
records the measurement and closes the mis-scoped slice.)

## The three substrate sub-problems

The ~178 failures decompose into three distinct substrate buckets, each with
its own root cause. They are NOT one fix.

### (1) Proto-receiver reification (~124 tests) — the big rock

`Object.getOwnPropertyDescriptor(Array.prototype, "forEach")` compiles
**host-free** (no CE) but returns `undefined` instead of a real data
descriptor. Root cause: **builtin methods are not first-class values in
standalone mode.** `Array.prototype.forEach` is synthesized inline at each
call site (or dispatched through a receiver-typed lowering); there is no
reified `Array.prototype` object carrying a property table, and no reified
function value to place in the descriptor's `.value` slot. The dynamic
`__getOwnPropertyDescriptor` native walks the open-object runtime's own
property table, finds nothing for a synthetic proto receiver, and returns
`undefined`. Spec attributes for a builtin method are `{ writable: true,
enumerable: false, configurable: true, value: <the method fn> }`; we can
answer the three boolean attributes from a static table, but the `.value`
slot requires a **real function value** for the builtin method — which the
standalone lane does not currently materialise.

### (2) Builtin-ctor-as-receiver (~63 tests) — hard CE

`Object.getOwnPropertyDescriptor(Array, "isArray")` **hard-CEs** with
`"__get_builtin not yet supported"`. Root cause: **builtin constructors are
not resolvable dynamic-shape receivers.** In standalone mode `__get_builtin`
refuses-loud (the open-object runtime does not expose it — see
`src/codegen/property-access.ts` ~L3943), so a constructor used as a _dynamic_
gOPD receiver reaches the `__get_builtin` shortcut with no static-constant
folding available and emits the located refusal instead of a descriptor.
Static member reads like `Array.isArray(x)` already resolve (constant
emitter), but the _reflective_ `gOPD(Array, "isArray")` form has no path.

Buckets (1) and (2) overlap: both need a reified builtin object (the
`.prototype` object in (1), the constructor object in (2)) that owns a
queryable property table whose entries can yield real descriptors.

### (3) Plain-object accessor-descriptor readback (~29 tests) — separate deferred substrate

A smaller bucket: `gOPD` on a **plain user object** with an accessor
(get/set) property returns a data descriptor or drops the accessor, because
the descriptor-readback path does not round-trip `get`/`set` function slots.
Root cause is distinct from (1)/(2) — it is an accessor-descriptor
representation gap in the open-object runtime (get/set closures + `call_ref`
to invoke them on read), not a builtin-MOP gap. **Track/deliver separately**;
it is deferred substrate of its own and should not be folded into the builtin
MOP work.

## Why `__builtinfn_gopd` does not extend to this

The existing `__builtinfn_gopd` machinery (introduced by #2861/#2863/#2896,
registered in `src/codegen/object-runtime.ts` ~L499) answers gOPD **only for
`name` / `length` on a builtin FUNCTION closure value** — i.e. when the
_receiver itself_ is already a first-class builtin function value and the key
is one of its own two metadata properties. It returns a fixed data descriptor
(`{ writable:false, enumerable:false, configurable:true }`) or null.

It does not extend to #2984 because:

- Its receiver is a **builtin function value**, not an `X.prototype` object
  or a constructor object. In (1)/(2) the receiver is a _namespace/proto_
  object that is not reified at all — there is nothing for `__builtinfn_gopd`
  to key off.
- It only knows two keys (`name`, `length`). The proto-receiver case needs to
  answer **every builtin method name** owned by that prototype, with a
  `.value` slot that is a real function value — a fundamentally larger table.
- Its `.value`-less fixed descriptor is exactly what falls short: the spec
  descriptor for a builtin method **must carry the method as `.value`**, which
  is the piece the standalone lane cannot currently produce.

So the fix is not a widening of `__builtinfn_gopd`'s key set; it needs a
builtin **object** meta-object protocol sitting a layer up, plus first-class
reification of the method values it points at.

## Rough shape of a real fix

Design sketch only (sizing, not a spec):

1. **Reify builtin prototype/constructor objects** as queryable meta-objects
   on the standalone lane — a per-builtin static descriptor table keyed by
   property name, produced at codegen time (Array.prototype → {forEach, map,
   filter, …}; Array → {isArray, from, of, …}). This is the shared
   prerequisite for buckets (1) and (2).
2. **Materialise builtin method values as first-class function values** so a
   descriptor's `.value` slot can hold the actual method (funcref/closure),
   not just its metadata. This is the heavy part — it touches how builtin
   methods are lowered (inline-at-callsite today) and interacts with the
   value-representation substrate.
3. **Route dynamic `gOPD(receiver, key)`** so a builtin-object receiver is
   recognised (not sent to the refusing `__get_builtin` shortcut) and
   dispatched into the meta-object table, building a full data descriptor
   ({value, writable, enumerable, configurable}) from the static entry.
4. Keep the host/gc lane **byte-inert** (gated on `ctx.standalone`, same
   reserve/fill discipline as the existing natives so late-import funcIdx
   shifts stay invariant).
5. Bucket (3) — accessor readback on plain objects — is a **separate**
   deliverable (get/set closure round-trip + `call_ref`), split out.

## Related representation-family work (same D1-disease class)

This is the **D1 "type-erased value representation"** disease class per the
June audit (`plan/log/analysis-2026-06/00-program-overview.md`): lowering
picks representation from the Wasm ValType rather than the JS type, so builtin
methods never become first-class JS values that a descriptor can point at.
Cross-reference **#2949** (IR dynamic value representation — a JsTag-carrying
`dynamic` kind in `IrType` to make untyped JS claimable): the ability to hold
a builtin method as a first-class tagged value is the same
representation-family capability #2949 is building. #2984's method-value
reification (step 2 above) should be designed to sit on top of #2949's
`dynamic`-kind substrate rather than inventing a parallel boxing scheme —
otherwise it re-breeds the D4 "duplicated representation" drift the audit
warns about.

## Acceptance

- gOPD on builtin proto/ctor receivers returns spec-correct descriptors
  (including a real `.value`) on the standalone lane; host/gc lane unchanged
  (byte-inert).
- Buckets (1) and (2) measured on the `built-ins/*/getOwnPropertyDescriptor`
  and `built-ins/Object/getOwnPropertyDescriptor` standalone subsets with zero
  regressions on a passing-test sweep.
- Bucket (3) split into its own follow-up (accessor-descriptor readback).
- Once landed, re-measure #2989 — its dynamic-descriptor TypeError assertions
  should become reachable and flip.
