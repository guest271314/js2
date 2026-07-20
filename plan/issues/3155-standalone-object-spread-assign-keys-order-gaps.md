---
id: 3155
title: "standalone: object spread / Object.assign / Object.keys-values order + object→primitive gaps (unmasked by the #86 vacuous-standalone audit)"
status: done
completed: 2026-07-17
sprint: 72
created: 2026-07-11
updated: 2026-07-19
priority: medium
horizon: m
feasibility: medium
area: codegen, runtime
goal: standalone-mode
related: [86, 2131, 2746, 2804, 3342]
origin: "#86 {standalone:true}-option-ignored audit (fable-wasm, 2026-07-11) — 3 tests were asserting standalone behavior while vacuously running gc-host; the real standalone lane fails."
loc-budget-allow:
  - src/compiler.ts
  # (#3155) the native standalone externref-join `compileArrayJoinExternNative`
  # must live beside `compileArrayJoinExtern` in array-methods.ts (+~100 LOC).
  - src/codegen/array-methods.ts
coercion-sites-allow:
  # (#3155) the native externref-join mirrors compileArrayJoinNative's existing
  # `__extern_toString` element-ToString (§7.1.17) — same coercion vocabulary,
  # relocated into the new externref-receiver arm, not novel hand-rolling.
  - src/codegen/array-methods.ts
---

# #3155 — standalone object spread / assign / key-enumeration gaps

## Source

Surfaced by **#86** (the `{ standalone: true }`-compile-option-ignored audit).
Three test files carried a "standalone" mode that, because the option was
silently dropped, ran the **gc-host** lane and passed vacuously. When #86
converted them to the real `target: "standalone"` lane, they FAIL — revealing
genuine standalone gaps. The standalone modes are now `describe.skip` /
`it.skip` with a pointer here (honest: explicitly pending, not falsely passing);
the host modes keep real coverage.

## Failing on the real standalone lane

- **`tests/issue-2804.test.ts`** — object spread `{ ...a, z }` + `Object.assign`
  copy keys/values, `Object.values`/`Object.getOwnPropertyNames`/`for-in`
  consistency. Fails with `TypeError: Cannot convert object to primitive value`
  and empty/mis-read key sets on standalone.
- **`tests/issue-2746.test.ts`** — `Object.keys` own-key listing paths.
- **`tests/issue-2131.test.ts`** — integer-key enumeration order
  (`Object.keys(o).join(",")` → `"1,2,b,a"`); the standalone `.join` / key
  read path fails ("Cannot convert object to primitive value").

## Root-cause hypothesis (to verify)

Two clusters, both standalone-only:

1. **object → primitive** — `Object.keys(o).join(",")` / template-literal on a
   standalone object array trips `Cannot convert object to primitive value`
   (the native ToPrimitive / string-coercion path for the key array or its
   elements is not wired standalone). Likely shares a root with the #2160 /
   #2358 standalone ToPrimitive substrate.
2. **key enumeration fidelity** — `Object.keys` / `Object.values` /
   `Object.assign` on a dynamic `$Object` return empty / mis-ordered sets
   standalone (integer-key canonical order, insertion order). Likely the
   dynamic `$Object` own-key walk (#2162 substrate family).

## 2026-07-16 harvest-errors measurement (test262 standalone lane)

The `/harvest-errors` pass against the 2026-07-16 standalone baseline
(`baseline_sha 6f89a7e8`, 27,408/43,106 pass) measured the residual
`Cannot convert object to primitive value` bucket at **107 failing records**
(official scope). Cluster-1 (object→primitive) is the dominant root, and its
largest concrete slice is **ToPrimitive on arguments to the native URI
functions** (all Wasm-native since #2500, but their argument-coercion path
can't reduce a dynamic `$Object`):

- `built-ins/decodeURI` 14, `built-ins/decodeURIComponent` 14,
  `built-ins/encodeURI` 12, `built-ins/encodeURIComponent` 12,
  `annexB/built-ins/escape`+`unescape` 8
  (e.g. `test/built-ins/decodeURI/S15.1.3.1_A2.4_T1.js` — passes
  `{toString(){…}}` to `decodeURI`)
- `language/expressions/assignment/dstr` 14 (coercion of destructured values)
- `built-ins/AggregateError` 8 + `built-ins/SuppressedError` 6 (message
  ToString on object args)

These belong to this issue's cluster-1 scope (shared #2160/#2358 substrate
root); listing them here so the acceptance measurement includes them.

## Acceptance

- The `describe.skip` / `it.skip` standalone modes in issue-2804 / 2746 / 2131
  are re-enabled (`describe`/`it`) and pass on `target: "standalone"` with 0
  regressions.
- `built-ins/Object/{keys,values,assign,getOwnPropertyNames}` + object-spread
  standalone test262 improve (measure).

## Resolution (2026-07-17, opus-c)

**Measured first.** Compiling the issue's cases with `target: "standalone"` and a
`WebAssembly.Module.imports` probe pinned the concrete failure: the
`Cannot convert object to primitive value` symptom is the **externref-array
`join`** path. `Object.keys(o).join(sep)` leaked `env::__array_join_any` (an
unsatisfiable host import → instantiate-against-`{}` fails). The other listed
sub-parts were already host-free on current main: object **spread** (`{...a,z}`),
**Object.assign**, **Object.keys(o).length**, and **Object.entries(o).length**
all compile to zero `env::*` imports and run correctly standalone.

**Fix.** Added `compileArrayJoinExternNative` (`src/codegen/array-methods.ts`):
under `noJsHost`, `compileArrayJoinExtern` now walks the externref array
natively — length via `__extern_length`, each element via `__extern_get_idx`
then §7.1.17 ToString via `__extern_toString` (all native-registered standalone,
the same helpers the receiver's own `.length` already uses host-free) — and folds
with the shared `emitStringJoinFold` over the native-string representation,
mirroring the WasmGC-vec `compileArrayJoinNative`. Host lane is byte-identical
(guarded on `noJsHost`; the 23 host-lane assertions in issue-2131/2746/2804 stay
green).

**Verified fixed standalone:** `Object.keys(o).join()` / `.join(",")` /
multi-char sep / integer-key canonical order (`"1,2,b,a"`) / empty-object (`""`)
/ single-key — all host-free and correct.

**Delivered:**

- `tests/issue-3155.test.ts` — permanent regression guard (#2093), in-wasm
  correctness + zero-`env::*`-import assertions.
- `tests/issue-2131.test.ts` — the vacuous `it.skip("standalone …")` is
  **un-skipped** and converted to a real in-wasm check (integer-key order), now
  passing on the true standalone lane.

**Carved out to #3342:** `Object.values(o).join(...)` and
`Object.getOwnPropertyNames(o).join(...)` take a **different** dispatch arm — the
join receiver-type probe misclassifies their result as a `Uint8ClampedArray`, so
they route to the TypedArray-`join` host lowering and leak
`env::Uint8ClampedArray_join`. Distinct root cause (type inference / probe
misread), unrelated to the externref-join fix here — tracked in #3342. The
describe.skip standalone blocks in issue-2746/2804 remain skipped because they
exercise those still-gapped `Object.values` / `getOwnPropertyNames` paths.
