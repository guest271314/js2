---
id: 3181
title: "standalone: Number.prototype brand-check / property-surface / method .length / toExp+toPrec no-arg (residual #3175 gap)"
status: done
completed: 2026-07-12
loc-budget-allow:
  - src/codegen/array-object-proto.ts
assignee: ttraenkler/dev-number-resid
created: 2026-07-12
updated: 2026-07-13
priority: medium
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: number
goal: standalone
umbrella: 2860
sprint: 71
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

## Implementation Plan

(arch, 2026-07-12. Anchors verified on `origin/main` pre-#2933; PR #2933 is
in-flight and only touches `plan/issues/3175-*` + its own code — re-grep
anchors after it lands, and pick up `buildThrowJsErrorInstrs` from it.)

Ship order: **C → B → D → A** (effort-ascending; each cluster is an
independently mergeable PR-let).

### Cluster C — method `.length` (3 files, S)

**Root cause**: for `Number.prototype.toString.length` the generic `.length`
property handler in `src/codegen/property-access.ts` runs BEFORE the
builtin-proto-member meta fold. The fold itself works — `.name` already
returns `"toString"` via `tryCompileStandaloneBuiltinProtoMemberMeta`
(property-access.ts:1104, called at :4186).

**Change** (`src/codegen/property-access.ts`):
- Locate the generic `.length` arm that intercepts the shape (grep for the
  `.length` dispatch ABOVE line 4186 in `compilePropertyAccess`'s ladder).
  Add a narrow deferral: when the receiver is itself a property access on a
  builtin prototype surface (`Number.prototype.<m>` /
  `<numLiteral|Number-typed expr>.<m>` resolving into the `$NativeProto` glue
  member set), skip the generic arm so control reaches the meta fold at
  :4186. Prefer a helper predicate `isBuiltinProtoMemberShape(expr)` shared
  with the fold rather than duplicating the shape test.
- In the glue (`src/codegen/array-object-proto.ts`, `NUMBER_PROTO_METHODS`
  at :208, registered via `makeGlue(...)` at :1550): verify
  `memberLength` (consumed at property-access.ts:1153) returns **0** for
  `valueOf` and `toLocaleString`, **1** for `toString`. The issue notes a
  `?? 1` default — add explicit per-member lengths instead of the fallback.

**Reuse**: `tryCompileStandaloneBuiltinProtoMemberMeta`
(property-access.ts:1104) and the `NUMBER_PROTO_METHODS` glue table
(array-object-proto.ts:208) — extend, do not add a new fold.

**Edge cases**: don't reorder `.length` for arrays/strings/arguments
(regression-sensitive); gate the deferral on the builtin-proto-member shape
only, standalone-gated like the fold itself.

**Tests**: `built-ins/Number/prototype/toString/length.js`,
`valueOf/length` (0), `toLocaleString/length` (0); scoped standalone sweep
of `built-ins/Number/prototype/**` + a host-lane byte-identity spot-check.

### Cluster B — property surface (~12 files, M)

**Root cause**: `Number.prototype` does not answer reflective own-property
queries (`hasOwnProperty("toString")`, `hasOwnProperty("constructor")`,
enumeration) — only direct method dispatch works.

**Change** (`src/codegen/array-object-proto.ts`):
- The `$NativeProto` machinery already models `Array.prototype`/
  `String.prototype` as objects (see `registerNativeProtoBuiltin` at :1550).
  Extend the same reflective arms for the Number brand:
  `hasOwnProperty(name)` over the glue's member table + `"constructor"`,
  and `Number.prototype.constructor === Number` identity.
- Grep how `Array.prototype`-surface tests pass today (the glue's
  `hasOwnProperty` arm) and mirror it — the member list is
  `NUMBER_PROTO_METHODS` ∪ {`constructor`, `toLocaleString`, ...} exactly as
  registered.

**Reuse**: `registerNativeProtoBuiltin` / `makeGlue`
(array-object-proto.ts:1550) — one table drives dispatch AND reflection; do
not build a parallel descriptor store.

**Tests**: `S15.7.4_A3.1..A3.7`, `S15.7.3.1_A2_T1/T2`, `S15.7.3.1_A3`,
`15.7.3.1-2`, `S15.7.4_A1`.

### Cluster D — toExponential/toPrecision no-arg + arg coercion (~8 files, M)

**Root cause** (two parts): (1) the no-arg render in
`src/codegen/number-format-native.ts` is a 6-digit approximation, not the
spec shortest/`ToString(x)` form; (2) the previous attempt to delegate
`toPrecision(undefined)` → `number_toString` hit the
`number_toString` ← `number_toString_radix` emit-order dependency
(number-format-native.ts:374-395: `ensureNumberFormatHelpers(which)` — the
"must run before" registration block) and was reverted with a CE.

**Change** (`src/codegen/number-format-native.ts`):
- In the helper-registration block (:374-395), make
  `number_toPrecision`/`number_toExponential` declare a dependency on
  `number_toString` the same way `number_toFixed` already does (":392 —
  number_toFixed needs number_toString for its |x| >= 1e21 branch"): add the
  name to `which` before minting, so registration order is topological, not
  incidental. This dissolves the emit-graph collision that killed the #3175
  attempt.
- `toPrecision(undefined)` → emit `call number_toString` (§21.1.3.5 step 2).
- `toExponential()` no-arg: implement trailing-zero-trim on the 6-digit
  render (sufficient for the cited test262 rows; full shortest-round-trip
  stays documented out of scope).
- Symbol/BigInt fractionDigits/precision args → real TypeError instance via
  `buildThrowJsErrorInstrs` (from PR #2933) before ToIntegerOrInfinity.

**Reuse**: `ensureNumberFormatHelpers` registration block
(number-format-native.ts:374-395); `buildThrowJsErrorInstrs` (#3175/PR
#2933); the existing ToIntegerOrInfinity truncation from #3175.

**Tests**: `toExponential/{undefined-fractiondigits,return-values,
tointeger-fractiondigits,return-abrupt-tointeger-fractiondigits-symbol}`,
`toPrecision/{undefined-precision-arg,exponential,tointeger-precision,
precision-cannot-be-coerced-to-a-number-in-range}`,
`toFixed/toFixed-tonumber-throws-typeerror-{bigint,toprimitive}`.

### Cluster A — brand check on transferred method values (~12 files, L)

**Root cause**: `s.toString = Number.prototype.toString; s.toString()` — the
method must exist as a first-class function VALUE that brand-checks its
receiver at CALL time (§21.1.3 "not generic" TypeError). Today the method
only exists as compile-time dispatch; a transferred reference either CEs or
runs without the brand gate.

**Change**:
1. Materialize `Number.prototype.<m>` reads (value position, not call
   position) as closures via the glue's member minting — the same path that
   already gives `.name`/`.length` their function-object identity
   (`tryCompileStandaloneBuiltinProtoMemberMeta` sits beside the read arm;
   grep array-object-proto.ts for where Array.prototype method VALUES are
   minted for transfer — follow that pattern for Number).
2. Inside each minted wrapper body, FIRST emit the receiver brand gate:
   `emitReceiverBrandCheck` (src/codegen/receiver-brand.ts:58) /
   `emitReceiverBrandThrow` (:146) against the boxed-Number brand
   (`$BoxedNumber` ref.test + raw-f64 receiver accept), throwing a real
   TypeError via `buildThrowJsErrorInstrs` on mismatch.
3. Dynamic dispatch of the transferred value goes through the existing
   closure/`__apply_closure` bridge — no new calling convention.

**Reuse**: `emitReceiverBrandCheck`/`emitReceiverBrandThrow`
(receiver-brand.ts:58/:146 — the #3171/#3174 shared gate, landed);
`NUMBER_PROTO_METHODS` glue; the closure-mint machinery of
`array-object-proto.ts` (`registerNativeProtoBuiltin`). Do NOT hand-roll a
per-method brand test.

**Edge cases**: receiver is a raw f64 (accept); receiver is a `$BoxedNumber`
(accept, unwrap `[[NumberData]]`); `String` object / plain object / null →
TypeError; `call`/`apply` transfer shapes.

**Tests**: `toString/S15.7.4.2_A4_T01..T05`, `valueOf/S15.7.4.4_A2_T01..T05`,
`toExponential/this-type-not-number-or-number-object`,
`toPrecision/this-type-not-number-or-number-object`.

### Global acceptance gates (all clusters)

- Zero host-mode regressions (host lane byte-identity for modules without
  the construct — every new arm `ctx.standalone`-gated).
- Standalone `built-ins/Number/prototype/**` sweep strictly increases from
  the post-#2933 130/168 baseline toward ≥139.
- Coordinate with PR #2933 (in-flight): branch AFTER it lands; its issue
  file (#3175) stays untouched by this work.

## Progress log

### Cluster C — DONE (2026-07-12, dev-number-resid)

`Number.prototype.<m>.length` folded to **NaN**. Fable review corrected the
root cause: NOT a dispatch-order bug — the shared `PROTO_METHOD_LENGTH` arity
table (`src/codegen/array-object-proto.ts`) was a plain object literal, so a
lookup of an `Object.prototype`-inherited method name
(`toString`/`valueOf`/`toLocaleString`) returned the INHERITED FUNCTION, not
`undefined`, slipping past the `?? 1` guard and emitting the `Function` as an
f64 → NaN.

Fix:
- Null-prototyped `PROTO_METHOD_LENGTH` (`Object.assign(Object.create(null),
  {...})`) + explicit `toString: 0, valueOf: 0, toLocaleString: 0` (correct
  cross-family default).
- `makeGlue` `memberLength` overrides Number's `toString` → 1
  (`Number.prototype.toString(radix)` §21.1.3.7 is the only family where
  `toString` ≠ 0).
- Same inherited-function hazard flagged & fixed in
  `BUILTIN_STATIC_METHOD_ARITY` (`src/codegen/builtin-fn-meta.ts`) via a
  `nullProtoDeep` wrapper (outer table + every inner record null-proto'd).

Bonus: also fixes `Array/String/Object.prototype.toString.length` (all were NaN
on main). Both changed paths are `ctx.standalone`-gated ⇒ zero host-mode impact.
Tests: `tests/issue-3181.test.ts` (10 cases, all pass). Adjacent #3175/#2933/
#2374/#2160/#3081 suites (50 cases) still green.

### Clusters B, D, A — REMAINING (honest scope)

Not started in this slice. Per the plan's C→B→D→A ship order these are separate
mergeable PR-lets and stay open under this issue:
- **B** (property surface ~12 files, M): `Number.prototype` reflective
  own-property queries (`hasOwnProperty`/enumeration/`constructor`) via the
  `$NativeProto`/`registerNativeProtoBuiltin` machinery.
- **D** (toExp/toPrec no-arg + coercion ~8 files, M): topologically order the
  `number_toString` helper registration (the #3175 emit-graph CE), delegate
  `toPrecision(undefined)` → `number_toString`, trailing-zero-trim
  `toExponential()`; Symbol/BigInt args → real TypeError.
- **A** (brand-check on transferred method values ~12 files, L): HARDEST.
  Note (Fable): `emitReceiverBrandCheck`'s primitive arm throws unconditionally
  for a raw-f64 receiver — must be handled around the gate so a raw-number
  receiver is ACCEPTED, not thrown.
