---
id: 2934
title: "Standalone: invalid-Wasm heterogeneous tail after #2878 (test/__closure_*/__cb_0 — distinct codegen bugs)"
status: in-progress
assignee: ttraenkler/dev-2934f
created: 2026-07-02
updated: 2026-07-02
priority: medium
feasibility: medium
task_type: bug
area: codegen
goal: standalone
related: [2860, 2868, 2878]
umbrella: 2860
---

# Standalone: invalid-Wasm heterogeneous tail after #2878

#2878 retired the `externref → eqref` coercion class (the
`__call_toString`/`__call_valueOf`/`__set_member_toString` invalid-Wasm bucket).
This tracks the **residual tail** measured on current `main` after that fix — a
set of **heterogeneous, unrelated** codegen defects (NOT a single mechanism, NOT
the eqref/funcIdx-shift class), so each is fixed as a **separate slice**.

## Measurement (2026-07-02, dev-2878)

`--target standalone` compile + `WebAssembly.compile` validate over a 3,500-file
`built-ins` stride sample, AFTER #2878: **26 invalid binaries** remaining.
Clustered by failing function + validator signature:

| failing fn           | count      | validator signature (representative)                                        | example test                                                                                                                   |
| -------------------- | ---------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `test`               | ~15        | `call[0] expected type (ref null …)`                                        | `String/prototype/concat/S15.5.4.6_A1_T8.js`                                                                                   |
| `test`               | (in above) | `call[0] expected type externref`                                           | `RegExp/prototype/test/S15.10.6.3_A8.js`                                                                                       |
| `test`               | (in above) | `array.get: Array type N has packed…` / `array.set[2] expected type i32`    | `TypedArray/prototype/set/array-arg-value-conversion-resizes-array-buffer.js`, `Uint8Array/prototype/toBase64/results.js`      |
| `__closure_2/4/7/20` | ~8         | `call[1] expected type f64` / `call[0] expected type (…)` / `struct.get[0]` | `Array/prototype/map/15.4.4.19-4-7.js`, `Array/prototype/filter/create-species-poisoned.js`, `Proxy/revocable/tco-fn-realm.js` |
| `__closure_5`        | 1          | `not enough arguments on the stack` (funcIdx-shift-shaped)                  | `AsyncFromSyncIteratorPrototype/next/for-await-next-rejected-promise-close.js`                                                 |
| `__cb_0`             | 1          | `array.set[2] expected type i32`                                            | `TypedArray/prototype/set/typedarray-arg-set-values-diff-buffer-other-type-conversions-sab.js`                                 |

(3,500-file sample → the full `built-ins` corpus + `language`/other roots scale
this ~3–4×.)

## Slices (each a separate net-positive PR)

The TypedArray packed-array surface turned out to be **several DISTINCT bugs**,
not one — triaged 2026-07-02:

- [x] **(1) TypedArray packed iterator READ (`.values()`/`.keys()`)** — DONE.
      `emitBoxedElem` (`array-methods.ts`) read a packed i8/i16 backing array with a
      plain `array.get` (validator error `Array type N has packed type i8`). Fixed
      with the established `getOp` idiom (`i8 → array.get_u`, `i16 → array.get_s`).
      Flips `TypedArray/prototype/values/make-{in,out-of}-bounds-after-exhausted.js`
      standalone invalid → valid.
- [ ] **(1b) TypedArray `.entries()`** — a DISTINCT `Binary emit error:
encodeValType: packed …` (a packed array type reaching a valtype position the
      encoder rejects). Not the same site as (1).
- [ ] **(1c) `TypedArray.prototype.set` / `Uint8Array.toBase64`** — the
      `array.set[2] expected i32, found array.get of externref` / packed-`array.get`
      errors here are a DISTINCT **DCE type-index remap** (`project_type_index_shift_
and_deadelim`): the pre-encode module has NO packed plain-`array.get`, so a
      post-codegen dead-type-elimination / dedup pass mis-remaps an `array.get`
      typeIdx onto a packed array. Needs a `dead-elimination.ts` audit — harder,
      likely warrants an architect spec.
- [ ] **(1d) simple `for (const v of u.values())`** — demotes to the IR path
      (`ir/from-ast: unknown class`), a separate IR-adoption gap.
- [x] **(2a) `RegExp/test` receiver → `hasOwnProperty`/`propertyIsEnumerable`
      missing `extern.convert_any`** — DONE (dev-2934b, slice 2). `RegExp.prototype.
test.hasOwnProperty('length')` — the receiver `RegExp.prototype.test` is a
      function object, compiled to a concrete function-object struct `(ref $fn)`.
      `compilePropertyIntrospection` (`object-ops.ts`) takes the `receiverWasm.kind
=== "externref"` branch because `resolveWasmType` reports the receiver's
      _static_ (method) type as `externref` — then pushed the receiver with
      `compileExpression` but **did not coerce** the actually-emitted `(ref $fn)` to
      externref, while the key argument WAS coerced. Result: `call[0] expected type
externref, found struct.new of type (ref …)` invalid Wasm. Fix: coerce the
      receiver's _compiled_ type (`recvType.kind !== "externref"` → `coerceType`
      → `extern.convert_any`), mirroring the existing key-arg coercion. Verified
      before/after over the 90-file `.hasOwnProperty/.propertyIsEnumerable('length')`
      DontEnum-length family: **9 standalone INVALID → 0** (RegExp `test`/`exec`/
      `toString` `_A8/_A9/_A10`); the other 81 were already valid and stay valid.
      Host-mode byte-neutral (host receiver is already externref → guard skips it;
      `S15.10.6.3_A8` et al. still pass host). Standalone runtime still fails these
      on the separate `__hasOwnProperty` function-`.length`-own semantics gap — a
      distinct issue, not this slice.
- [x] **(2b) `String(x).<method>()` + `exec(...).toString()` receiver
      coercion** — DONE (dev-2934f, slice 4). Two more "static type says X,
      compiled value is Y" receiver gaps, same class as (2a):
  1. `String(42).concat(void 0)` — `number_toString` returns the native string
     EXTERNALIZED (`extern.convert_any`), so a statically-string-typed receiver
     COMPILES to externref; `compileNativeStringMethodCall`'s `emitReceiver`
     (`string-ops.ts`) fed it uncoerced to `__str_concat((ref null $AnyString),
…)` → `call[0] expected (ref null 6), found call of externref`. Fix:
     emitReceiver casts an externref result back via the established
     `emitNativeStringRefFromExternref` inverse — covers EVERY string-method
     arm (concat/charAt/indexOf/slice/…) in one place.
  2. `regObj.exec(str).toString()` — static receiver type resolves externref,
     but standalone lowers exec natively to a capture-array vec `(ref null
   $Vec)`; the generic `.toString()` fallback (`expressions/calls.ts`) passed
     the raw ref to `__extern_toString(externref)` → `call[0] expected
   externref, found if of (ref null 98)`. Fix: coerce the COMPILED type
     (mirrors the 2a fix). Runtime ToString-of-match-array semantics is a
     separate pre-existing gap (2a precedent) — this slice is validity.
     Verified: 120-file concat/exec/toString sweep 115→117 VALID (+2, 0 new
     invalid); byte-identical host mode + standalone literal-receiver paths.
     Tests: `tests/issue-2934-receiver-coercion-2b.test.ts`.
     **Residual (NOT this slice):** (i) `concat/S15.5.4.6_A4_T2.js` — "not enough
     arguments on the stack" (wasm-dis can't even parse: stack-arity/body-mutation
     class, belongs with slice 3); (ii) Array map/filter `create-species-*` /
     `__closure_*` `call[1] expected f64, found array.get of externref` — the
     non-closure callback path bridges through the HOST import `env.__call_1_f64`
     even in standalone (`setupArrayCallback`, `array-methods.ts:~6033`) AND
     mismatches the boxed-any (externref) element rep of `new Array(N)`; needs a
     standalone-native callback-bridge design (host-import leak + IsCallable +
     hole semantics), likely an architect spec — split to its own slice.
- [ ] **(3) `__closure_5` `not enough arguments on the stack`** — the one
      funcIdx-shift-shaped failure (for-await async path); may share the #2918
      late-import class.

## Approach

Per the #2868/#2878 playbook: pick one repro per cluster, disassemble with
`node_modules/.bin/wasm-dis`, read the exact validator complaint, cluster by
shared construct, fix the emitter. Each slice ships independently.

## Acceptance

- Each named cluster: standalone invalid → valid module for its repros.
- 0 test262 regressions; full `merge_group` + standalone floor.
- Pure correctness (invalid binary → valid) — no host-mode path touched.
