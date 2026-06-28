---
id: 2729
title: "WasmGC backend: new Uint8Array(n) element store skips ToUint8 (u[0]=257 reads 257, u[0]=NaN reads NaN)"
status: in-progress
assignee: ttraenkler/agent-aa6c288d8cd3cb14b
sprint: current
created: 2026-06-26
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

## Notes

The linear backend's ToUint8 store is already correct (#2715). This issue is the
WasmGC counterpart only.
