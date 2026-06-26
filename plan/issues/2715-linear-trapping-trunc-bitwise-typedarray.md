---
id: 2715
title: "Linear backend: trapping i32.trunc_f64_s in bitwise ops + typed-array stores → use trunc_sat / ToInt32 wrap"
status: ready
sprint: 66
created: 2026-06-26
updated: 2026-06-26
priority: high
feasibility: medium
reasoning_effort: medium
task_type: fix
area: codegen-linear
language_feature: standalone
goal: standalone-everything
parent: 2711
---
# #2715 — Linear backend traps on float→int conversion (bitwise / Uint8Array)

**Parent:** #2711 (standalone↔host differential parity gate). **Surfaced by**
the cross-backend differential harness (`tests/cross-backend-diff.test.ts`):
`(0/0) | 0` returns `0` on WasmGC/host but **traps** on the linear backend with
`float unrepresentable in integer range`.

## Root cause

The linear backend lowers bitwise operands and `Uint8Array` element stores with
the **trapping** `i32.trunc_f64_s` opcode (`src/codegen-linear/index.ts:3954`
for bitwise, `:3201` for the typed-array store), instead of JS `ToInt32` /
`ToUint8` semantics. JS requires:

- `NaN | 0 === 0`, `Infinity | 0 === 0`, and modular 2³² wrap for the bitwise
  family (`& | ^ << >> >>> ~`).
- `u8[i] = NaN` stores `0` (ToUint8 of NaN), never traps.

`i32.trunc_f64_s` traps on NaN / out-of-range, so these programs trap instead of
producing the wrapped value — a standalone-only miscompile (host mode is
correct because it routes through a different path).

## Fix sketch

- Use the non-trapping saturating opcode `i32.trunc_sat_f64_s` as the base
  conversion, then apply the JS modular wrap (`ToInt32` = truncate toward zero
  mod 2³², reinterpret signed; `ToUint8` for the byte store). Saturation alone
  is not full ToInt32 — large finite values must wrap, not clamp — so the wrap
  arithmetic still has to be emitted; `trunc_sat` only removes the trap on
  NaN/∞.
- Mirror whatever the WasmGC backend already does for `ToInt32`/`ToUint8`.

## Acceptance criteria

- [ ] `(0/0)|0`, `(1/0)|0`, large-magnitude `x|0` agree with host on the linear
      backend (add to the cross-backend corpus once green).
- [ ] `u8[i] = NaN` stores `0` on linear, no trap.
- [ ] No remaining trapping `i32.trunc_f64_s` on the JS-number→int paths.
