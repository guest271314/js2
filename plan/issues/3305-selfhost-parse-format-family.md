---
id: 3305
title: "Self-host stdlib: convert parse-number-native.ts + number-format-native.ts hand-emitted Instr[] to TS (family #2)"
status: ready
sprint: current
priority: high
horizon: xl
feasibility: hard
task_type: refactor
area: codegen, stdlib, ir
language_feature: compiler-internals
goal: ir-full-coverage
created: 2026-07-16
depends_on: [3256]
related: [3141, 3256, 3257]
origin: "#3257 re-scope (2026-07-16) — array-methods.ts measured net-negative-infeasible; family #2 verified as the real Tier-2 target"
---

# #3305 — Self-host the parse/format family (`parse-number-native.ts` + `number-format-native.ts`)

## Problem

`src/codegen/parse-number-native.ts` (1,838 LOC) and
`src/codegen/number-format-native.ts` (1,712 LOC) are family #2 of
`plan/self-hosting-scale-up.md` (est. **−2.8k net**) — and, per the #3257
measurement, the LARGEST remaining self-host target whose units actually
qualify under the net-negative rule
(`reference_selfhost_netnegative_needs_full_elemkind_dialect`): unlike
`array-methods.ts` (call-site inline emitters, re-scoped in #3257 §Result),
these files register **9 discrete fixed-ABI funcMap helpers with pure
algorithm bodies**:

- `parse-number-native.ts`: `parseFloat` (~:149), `__str_to_number` (~:512,
  ~360-line body), `parseInt` (~:1482, ~970-line region).
- `number-format-native.ts`: `__num_fmt_finalize` (~:144),
  `number_toString` (~:507), `number_toString_radix` (~:848),
  `number_toFixed` (~:1075), `number_toExponential` (~:1414),
  `number_toPrecision` (~:1691) — 230–360 LOC each.

## Why it is dialect-ready TODAY (verified 2026-07-16)

The #3256 Tier-1 groundwork covers everything these bodies need — zero new
resolver machinery:

- **Parse direction**: `s.charCodeAt(i)` scans (on-demand `__str_charCodeAt`
  via the driver's resolveFunc arm) + pure f64 arithmetic + `s.length` +
  `.substring`. Whitespace skipping can reuse the self-hosted
  `__sh_str_isWs` (declared `(f64) -> i32` callee).
- **Format direction**: string building via substring-of-literal digit
  tables (`"0123456789abcdefghijklmnopqrstuvwxyz".substring(d, d + 1)`) +
  `+` concat + `""` literals (`emitStringConst` landed in #3256); f64
  decomposition via `Math_floor`/`Math_abs`-style sibling callees (the
  self-hosted Math family is funcMap-registered).
- **ABI preservation**: same thunk discipline as #3256 for any i32
  params/results in the legacy signatures (widen `f64.convert_i32_s` /
  narrow `i32.trunc_sat_f64_s`); string params/results are
  `(ref $AnyString)` on both sides.

## Scope (leaf-first, measure per unit)

1. Convert ONE leaf first (recommend `number_toString_radix` or
   `parseFloat`'s scanner) — prove end-to-end, measure net LOC +
   containment, exactly like #3256 step 2.
2. Then the rest of the 9 helpers, one-or-few per commit, keeping any
   precision-critical kernel hand-written where bit-exactness demands it
   (the escape hatch works both ways — scale-up plan §mechanism 3).
3. Refresh `scripts/godfile-profile-baseline.json` per conversion
   (`node scripts/profile-godfiles.mjs --update`) so the gate ratchets.

## Acceptance

- ≥1 helper self-hosted with hand `Instr[]` deleted and measured net −LOC;
  target the full family (est. −2.5k+).
- Validation: numeric round-trip A/B vs JS semantics (host lane) on a corpus
  incl. ±0, NaN, ±Infinity, denormals, radix 2..36, exponent boundaries,
  `toFixed`/`toPrecision` digit-count edges; standalone + wasi lanes green;
  host lane byte-identical (containment SHA — these helpers only emit in
  native/standalone modes, mirroring #3256's containment shape).
- Both pure-Wasm lanes zero host imports.
- Update `plan/self-hosting-scale-up.md` row 2 with measured compression.

## Non-goals

- `array-methods.ts` (re-scoped, see #3257 §Result), object/map/iterator
  families (Tier-3, #3258 and later).
