---
id: 2729
title: "WasmGC backend: new Uint8Array(n) element store skips ToUint8 (u[0]=257 reads 257, u[0]=NaN reads NaN)"
status: done
assignee: ttraenkler/agent-aa6c288d8cd3cb14b
sprint: 69
created: 2026-06-26
completed: 2026-06-28
priority: medium
feasibility: medium
task_type: bug
area: codegen
language_feature: typed-arrays
goal: core-semantics
related: [2715]
---

# #2729 — WasmGC Uint8Array element store does not apply ToUint8

## Problem

On the **WasmGC** backend (default `target`), assigning an out-of-range or
non-integer value to a `Uint8Array` element does not apply the §7.1.x ToUint8
conversion — the element reads back the raw assigned value instead of the wrapped
byte:

```ts
const u = new Uint8Array(1);
u[0] = 257;
u[0]; // → 257  (should be 1)
u[0] = -1;
u[0]; // → -1   (should be 255)
u[0] = 0 / 0;
u[0]; // → NaN  (should be 0)
```

Surfaced by #2715: the cross-backend differential harness flagged a divergence
between WasmGC and linear for `new Uint8Array(1); u[0]=NaN; return u[0]` —
**linear is now correct (0)** after #2715, but WasmGC returns `NaN`.

## Root cause (suspected)

The `new Uint8Array(n)` (no explicit `ArrayBuffer`) element-assignment path on the
WasmGC backend appears to store/return the raw RHS rather than routing through a
packed byte store + ToUint8. Contrast: a `Uint8Array` over an explicit
`ArrayBuffer` (and the `array.set` packed-store path used elsewhere) truncates
correctly. Verify whether the `new Uint8Array(n)` form lowers to a real packed
backing store at all.

## Acceptance criteria

- `u[0] = 257` reads back `1`, `u[0] = -1` reads back `255`, `u[0] = NaN`/`±Inf`
  reads back `0` on the WasmGC backend.
- Re-add the `numeric/uint8-store-touint8` cross-backend corpus entry (removed in
  #2715 because of this divergence) so the gate covers it once both backends agree.
- No regression in existing TypedArray tests.

## Resolution

Root cause confirmed: `typedArrayVecStorage` (src/codegen/index.ts) only packs a
typed array into `i8`/`i16`/`i32` storage under **wasi/standalone**; on the
default host/gc backend a `new Uint8Array(n)` is backed by an **f64 vec**. The
f64 element-store path in `compileElementAssignment` (src/codegen/expressions/
assignment.ts) applied no conversion, so the raw `f64` was stored and read back
verbatim (`u[0]=257`→257, `u[0]=-1`→-1, `u[0]=3.7`→3.7, `u[0]=NaN`→NaN).

Fix: when the element-assignment receiver is a `Uint8Array` whose backing element
is `f64` (the host/gc case), apply ToUint8 (§7.1.10) explicitly before the store —
`emitToInt32` (NaN/±Inf→0, truncate toward zero, reduce mod 2^32) then `& 0xFF`,
then widen back to `f64` (`f64.convert_i32_u`) for the f64 vec element. This
mirrors the linear backend (#2715) and the wasi/standalone `array.set`
i8-truncation path, which are untouched (the fix is gated on `element.kind ===
"f64"`).

## Test Results (WasmGC / default backend)

All pass: `u[0]=257`→1, `256`→0, `-1`→255, `-256`→0, `-257`→255, `1e20`→0,
`3.7`→3, `255.9`→255, `511.5`→255, `0/0`→0, `±1/0`→0; in-range 0/200/255 and
loop/variable-RHS writes unchanged. The restored `numeric/uint8-store-touint8`
cross-backend corpus entry now AGREES across WasmGC and linear on all 11 calls.
Regression suites green: cross-backend-diff, issue-2715, issue-2593
(typedarray-intwidth), issue-1787 (packed-typedarray-semantics), issue-2648
(typedarray-search-packed-elem). (`tests/typed-array-basic.test.ts` and
`tests/arraybuffer-dataview.test.ts` have 17 pre-existing `string_constants`
instantiate-harness failures unrelated to this change — they fail identically on
pristine main.)

## Follow-up (out of scope)

- **Other integer views share the host/gc gap**: `new Int8Array(n)`,
  `Int16Array`, `Uint16Array`, `Int32Array`, `Uint32Array` element stores on the
  host/gc backend likewise skip their ToIntN coercion (`Int8Array[0]=257`→257).
  `Uint8ClampedArray` is already correct (ToUint8Clamp). The linear backend does
  not yet support these stores cross-backend, so they are not yet corpus-gated.
- **Compound / unary element updates** (`u[0]+=n`, `u[0]++`) also skip ToUint8 on
  the host/gc backend (separate code path); linear CE's on them, so they cannot
  be added to the cross-backend corpus yet.

## Notes

The linear backend's ToUint8 store is already correct (#2715). This issue is the
WasmGC counterpart only.
