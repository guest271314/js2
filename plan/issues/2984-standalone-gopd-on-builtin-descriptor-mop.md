---
id: 2984
title: "Standalone gOPD-on-builtin descriptor MOP (~178: getOwnPropertyDescriptor on builtin objects / proto receivers)"
status: ready
sprint: current
priority: high
horizon: xl
feasibility: hard
area: codegen, runtime
goal: standalone-mode
related: [2965, 2861, 2863, 2896, 2949, 2989]
origin: "#2965 descriptor-cluster triage — follow-up class 1"
assignee: ttraenkler/sr-gopd
---

# #2984 — standalone gOPD-on-builtin descriptor MOP

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
