---
id: 3175
title: "standalone: Number.prototype.toString(radix)/toFixed/valueOf spec semantics + prototype surface (74 gap tests)"
status: ready
created: 2026-07-12
updated: 2026-07-12
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: number
goal: standalone
umbrella: 2860
sprint: current
horizon: m
related: [2860, 3078, 3081, 2861]
origin: "PO groom of #2860 umbrella, 2026-07-12 lane-baseline diff"
---

# #3175 — standalone: Number.prototype method spec semantics

## Problem

**74 host-pass tests are not host-free-standalone passes** under
`built-ins/Number/prototype/` (plus ~28 more direct `built-ins/Number/*` rows,
mostly boxed-Number-object semantics; measured 2026-07-12 lane-baseline diff,
method in #3169).

Measured signatures:

- The DOMINANT bucket (34 rows, `assert.sameValue(Number.prototype.toStr…`):
  **`toString(radix)`** — the S15.7.4.2 corpus calls
  `Number.prototype.toString.call(x, radix)` / `(n).toString(r)` for radix
  2–36 and checks digits; also radix-argument coercion order and
  `RangeError` on radix outside 2..36. The existing ryu-based formatter
  (`src/codegen/number-ryu.ts`) is decimal-only on this path.
- `hasOwnProperty`/property-surface rows (7): `Number.prototype` member
  descriptors (`length`/`name` of the methods, prototype own-property set).
- `valueOf`/brand rows: `Number.prototype.valueOf.call(nonNumber)` must throw
  `TypeError`; boxed `new Number(x)` receivers must unwrap.
- toFixed argument-coercion edges (S15.7.4.5 A1.x) beyond the
  undefined-arg fix #3078 already landed.

## ANTI-BLOAT directive

- Extend `src/codegen/number-format-native.ts` / `number-ryu.ts` in place:
  add an integer+fraction radix-N digit emitter next to the existing decimal
  path (shared digit-table with `parseInt`'s radix tables if present) — do
  NOT bolt a separate `toStringRadix` handler onto the dispatcher.
- Brand check (`valueOf`/`toString` on non-Number receivers) reuses the
  shared brand-preamble pattern (#3171/#3174) with the boxed-Number brand.
- Method `.length`/`.name`/descriptor surface rows go through the EXISTING
  builtin-fn metadata machinery (`src/codegen/builtin-fn-meta.ts`, #2896) —
  add table entries, not code.
- #3081 (Number namespace const receiver invalid-wasm) is a different,
  namespace-side bug — don't absorb it.

## Acceptance criteria

- ≥55 of the 74 measured `Number/prototype` gap tests flip to host-free
  standalone passes.
- Sample tests:
  - `test/built-ins/Number/prototype/toString/S15.7.4.2_A2_T02.js` (radix)
  - `test/built-ins/Number/prototype/toFixed/S15.7.4.5_A1.4_T01.js`
  - `test/built-ins/Number/prototype/valueOf/length.js`
- Zero host-mode regressions; zero standalone high-water regressions.
- One PR, Number family only.
