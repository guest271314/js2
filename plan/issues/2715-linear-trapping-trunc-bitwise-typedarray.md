---
id: 2715
title: "Linear backend: trapping i32.trunc_f64_s in bitwise ops + typed-array stores → use trunc_sat / ToInt32 wrap"
status: done
sprint: 67
created: 2026-06-26
updated: 2026-06-26
completed: 2026-06-26
assignee: ttraenkler/dev1
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

- [x] `(0/0)|0`, `(1/0)|0`, large-magnitude `x|0` agree with host on the linear
      backend (added the `numeric/bitwise-toint32-nan-wrap` cross-backend corpus entry).
- [x] `u8[i] = NaN` stores `0` on linear, no trap.
- [x] No remaining trapping `i32.trunc_f64_s` on the JS-number→int paths.

## Resolution (2026-06-26, dev1)

Added a non-trapping `emitToInt32` to the linear backend (`src/codegen-linear/index.ts`)
mirroring the WasmGC `emitToInt32` (binary-ops.ts): `f64.trunc` → modular
reduction `x - floor(x/2³²)*2³²` → `i32.trunc_sat_f64_u`. NaN/±∞ map to 0 and
large magnitudes wrap mod 2³² instead of trapping. A new `compileExprToInt32`
routes bitwise operands through it.

Sites changed (all the JS-number→int paths):

- unary `~` operand
- binary bitwise operators (`& | ^ << >> >>>`)
- bitwise compound assignment (`&= |= ^= <<= >>= >>>=`)
- `Uint8Array` element store (ToUint8 — `__u8arr_set`'s `i32.store8` keeps the low byte)

The trapping `compileExprToI32` is retained (renamed-in-doc) for **internal**
integer conversions (array indices, lengths, struct-handle slots) where the
value is a representable integer and a trap on garbage is acceptable; the 4
native-`i32`-typed field/handle conversion sites (`index.ts` ~1658/1930/3584/4393)
are intentionally left on it (native-type semantics, not JS ToInt32).

Verified every case against the JS oracle: `(0/0)|0===0`, `1e20|0===1661992960`,
`4294967297|0===1`, `-1>>>0===4294967295`, `~(0/0)===-1`, `u8[0]=257→1`,
`u8[0]=NaN→0`, `u8[0]=-1→255`. Tests: `tests/issue-2715.test.ts` (22) +
`numeric/bitwise-toint32-nan-wrap` cross-backend corpus entry. Full linear suite
(18 files / 159 tests) + cross-backend-diff green.

**Discovered + filed #2729**: the WasmGC backend has a _separate_ pre-existing
bug — `new Uint8Array(n)` element stores skip ToUint8 entirely (`u[0]=257` reads
257, `u[0]=NaN` reads NaN). That's why a Uint8Array cross-backend corpus entry is
NOT added here (the backends diverge for an unrelated reason); it's tracked in
#2729 and the corpus entry should be added once WasmGC is fixed.
