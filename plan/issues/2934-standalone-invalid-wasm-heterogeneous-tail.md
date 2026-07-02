---
id: 2934
title: "Standalone: invalid-Wasm heterogeneous tail after #2878 (test/__closure_*/__cb_0 — distinct codegen bugs)"
status: in-progress
assignee: ttraenkler/dev-2878
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

| failing fn | count | validator signature (representative) | example test |
| ---------- | ----- | ------------------------------------ | ------------ |
| `test` | ~15 | `call[0] expected type (ref null …)` | `String/prototype/concat/S15.5.4.6_A1_T8.js` |
| `test` | (in above) | `call[0] expected type externref` | `RegExp/prototype/test/S15.10.6.3_A8.js` |
| `test` | (in above) | `array.get: Array type N has packed…` / `array.set[2] expected type i32` | `TypedArray/prototype/set/array-arg-value-conversion-resizes-array-buffer.js`, `Uint8Array/prototype/toBase64/results.js` |
| `__closure_2/4/7/20` | ~8 | `call[1] expected type f64` / `call[0] expected type (…)` / `struct.get[0]` | `Array/prototype/map/15.4.4.19-4-7.js`, `Array/prototype/filter/create-species-poisoned.js`, `Proxy/revocable/tco-fn-realm.js` |
| `__closure_5` | 1 | `not enough arguments on the stack` (funcIdx-shift-shaped) | `AsyncFromSyncIteratorPrototype/next/for-await-next-rejected-promise-close.js` |
| `__cb_0` | 1 | `array.set[2] expected type i32` | `TypedArray/prototype/set/typedarray-arg-set-values-diff-buffer-other-type-conversions-sab.js` |

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
- [ ] **(2) `call[0]/call[1] expected type …` in `test`/`__closure_*`** — a
  wrong-typed argument at a call site (`String/concat` → `call[0] expected (ref
  null 6), found call of externref`; `RegExp/test` → `call[0] expected externref,
  found struct.new of (ref 101)` — a missing `extern.convert_any`; Array
  map/filter `create-species-*` callbacks). Each a coercion/typing site.
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
