---
id: 3181
title: "standalone: Number.prototype brand-check / property-surface / method .length / toExp+toPrec no-arg (residual #3175 gap)"
status: ready
created: 2026-07-12
updated: 2026-07-12
priority: medium
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: number
goal: standalone
umbrella: 2860
sprint: current
horizon: m
related: [2860, 3175, 3171, 3174, 2896]
origin: "residual clusters split off from #3175 (PR #2933) after the +46 dominant-bucket close"
---

# #3181 — standalone Number.prototype residual clusters (from #3175)

## Problem

#3175 (PR #2933) closed the DOMINANT standalone gap under
`built-ins/Number/prototype/**` — the `Number.prototype.<m>()` receiver
`[[NumberData]]` = +0 recovery, `toString(undefined)` base-10, `toFixed`
ToIntegerOrInfinity truncation, and real `RangeError` instances — flipping
**84 → 130 of 168** standalone passes (+46). The `≥55` acceptance bar was NOT
met; ~38 files remain, in FOUR independent clusters below. Each is a separate,
harder slice than the receiver fix, which is why they were split off here rather
than forced into #3175 (which stays `in-progress`).

Measurement method: real `wrapTest` + `compile({target:"standalone"})` over every
`Number/prototype` file (same harness as #3175).

## Residual clusters

### A. Brand-check / "not generic" (~12 files) — HARDEST

- `toString/S15.7.4.2_A4_T01..T05`, `valueOf/S15.7.4.4_A2_T01..T05`,
  `toExponential/this-type-not-number-or-number-object`,
  `toPrecision/this-type-not-number-or-number-object`.
- Shape: `s.toString = Number.prototype.toString; s.toString()` where `s` is a
  `String`/other object → must throw **TypeError** ("not generic", §21.1.3).
- Needs `Number.prototype.<m>` materialized as a **first-class function VALUE**
  that brand-checks its receiver on transfer/dynamic-dispatch. Wire the shared
  brand preamble from **#3171/#3174** (`src/codegen/receiver-brand.ts` /
  `collections-brand.ts` landed on main) to the boxed-Number brand. This is the
  bulk of the remaining work.

### B. Property surface (~12 files)

- `S15.7.4_A3.1..A3.7` (`Number.prototype.hasOwnProperty("constructor"|method)`),
  `S15.7.3.1_A2_T1/T2`, `S15.7.3.1_A3`, `15.7.3.1-2`, `S15.7.4_A1`.
- Needs `Number.prototype` as a real object exposing its own-property set +
  descriptors (`hasOwnProperty`, property enumeration). Likely reuses the
  `array-object-proto.ts` `$NativeProto` machinery already used for
  `Array.prototype`/`String.prototype` — extend the `NUMBER_PROTO_METHODS`
  wiring so `Number.prototype` answers reflective own-property queries.

### C. Method `.length` (3 files)

- `toString/length` (=1), `valueOf/length` (=0), `toLocaleString/length` (=0).
- The `.name` fold ALREADY fires
  (`tryCompileStandaloneBuiltinProtoMemberMeta`, `property-access.ts`) — `.name`
  returns "toString" correctly. `.length` returns NaN because an EARLIER generic
  `.length` handler intercepts the `Number.prototype.<m>.length` shape before
  the meta fold at ~L4186. Fix = run the meta fold before the generic `.length`
  handler for this shape (dispatch-order), OR let the generic handler defer the
  builtin-proto-member shape to the fold. Small but needs care to avoid
  property-access reordering regressions. Also verify `PROTO_METHOD_LENGTH` /
  `memberLength` returns 0 for `valueOf`/`toLocaleString` (currently `?? 1`).

### D. toExponential / toPrecision no-arg + coercion (~8 files)

- `toExponential/{undefined-fractiondigits,return-values,tointeger-fractiondigits,
  return-abrupt-tointeger-fractiondigits-symbol}`,
  `toPrecision/{undefined-precision-arg,exponential,tointeger-precision,
  precision-cannot-be-coerced-to-a-number-in-range}`, plus
  `toFixed/toFixed-tonumber-throws-typeerror-{bigint,toprimitive}`.
- The standalone no-arg render is a documented **6-digit approximation**
  (`number-format-native.ts`: "shortest round-trip out of scope"), so
  `(123.456).toExponential()` → `"1.234560e+2"` not `"1.23456e+2"`, and
  `toPrecision(undefined)` should be `ToString(x)` (§21.1.3.5 step 2) but the
  fix collides with the `number_toString` ← `number_toString_radix` emit-graph
  (attempted in #3175, reverted with a CE). Untangle the emit dependency so
  `number_toString` is available to the no-arg toPrecision delegation, and
  implement a shortest-representation (or trailing-zero-trim) no-arg render.
  Symbol/BigInt args must throw **TypeError** as a real instance.

## Acceptance criteria

- Address clusters A–D (any subset is a valid partial PR — prefer C then B then
  A/D by effort). Net standalone `Number/prototype` passes strictly increase
  toward the original #3175 `≥55` bar (130 → ideally ≥139 to clear it).
- Zero host-mode regressions; zero standalone high-water regressions.
- Number family only.

## Notes

- Do NOT re-do #3175's receiver / undefined-radix / toFixed-trunc / RangeError
  work — it landed in PR #2933. Start from post-#2933 main.
- `buildThrowJsErrorInstrs` (helpers.ts, added in #3175) is the reusable
  conditional-throw helper for any new TypeError/RangeError instance gate here.
