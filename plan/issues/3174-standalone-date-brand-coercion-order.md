---
id: 3174
title: "standalone: Date receiver brand checks + ToPrimitive coercion order (get*/set*/toISOString/Symbol.toPrimitive — 107 gap tests)"
status: done
assignee: ttraenkler/sendev-date-3174
created: 2026-07-12
updated: 2026-07-19
completed: 2026-07-16
priority: high
feasibility: hard
task_type: bug
area: codegen
es_edition: multi
language_feature: date
goal: standalone
umbrella: 2860
sprint: 72
horizon: m
related: [2860, 2671, 2891, 3171]
loc-budget-allow:
  - src/codegen/any-helpers.ts
  - src/codegen/array-object-proto.ts
coercion-sites-allow:
  - src/codegen/date-reflective-setters.ts
origin: "PO groom of #2860 umbrella, 2026-07-12 lane-baseline diff; slices the Date area of tracking issue #2671"
---

# #3174 — standalone: Date brand checks + coercion order

## Problem

**107 host-pass tests are not host-free-standalone passes** under
`built-ins/Date/` (83 of them under `Date/prototype/`; measured 2026-07-12
lane-baseline diff, method in #3169). This slices the Date area that tracking
issue #2671 explicitly asks to be sliced, restricted to the standalone lane.

Measured signatures:

- The BULK (52 rows: `returned 3 — assert #2 … assert.throws(TypeError,
  function() { g*/s*…`) are the S15.9.5.x `A6_T*` **brand-check** tests:
  every `Date.prototype.get*/set*/to*` must throw `TypeError` when applied to
  a non-Date receiver (`Date.prototype.getTime.call({})`,
  `.call(Date.prototype)` — note `Date.prototype` itself is NOT a Date in
  ES6+). Assert #1 passes (the happy path works); assert #2 (the throw)
  doesn't.
- **ToPrimitive / coercion order** (~10 rows): `coercion-order.js`,
  `value-symbol-to-prim-return-obj.js`, `value-to-primitive-call-err.js` —
  `new Date(value)` must run the full §21.4.2.2 ToPrimitive protocol
  (Symbol.toPrimitive lookup errors propagate, object-returning exotic
  toPrimitive falls through correctly). #2891 built the
  valueOf→toString fallthrough for nominal structs — extend, don't duplicate.
- `setTime`-family argument `ToNumber` side-effect ordering; `Date.parse`
  edge rows (2); `Date.prototype[Symbol.toISOString/toPrimitive]` surface
  rows.

## ANTI-BLOAT directive

- The native Date kernel EXISTS (`src/codegen/date-parse-native.ts` + the
  Date arms in the closed-method dispatcher). Add ONE shared
  [[DateValue]]-brand preamble applied to every Date prototype-method arm in
  `closed-method-dispatch.ts` — the same shared-gate shape as the collections
  brand gate (#3171); if #3171 lands its generic brand-preamble helper first,
  REUSE it with the Date brand.
- Coercion-order rows extend the EXISTING `__to_primitive` /
  `coercion-engine.ts` protocol (#2862/#2891 lineage) — no Date-local
  ToPrimitive copy.

## Acceptance criteria

- ≥80 of the 107 measured gap tests under `built-ins/Date/` flip to host-free
  standalone passes.
- Sample tests:
  - `test/built-ins/Date/prototype/toISOString/15.9.5.43-0-11.js`
  - `test/built-ins/Date/S15.9.3.1_A6_T5.js` (brand throws)
  - `test/built-ins/Date/coercion-order.js`
- Zero host-mode regressions; zero standalone high-water regressions.
- One PR. Locale/timezone-dependent formatting rows are out of scope if they
  need host TZ data — note them in the PR instead of shimming.

## Implementation Notes (2026-07-16, sendev-date-3174)

Local measurement first (probe = wrapTest + `--target standalone` +
host-free instantiate, `skipSemanticDiagnostics: true` to match the real
runner): 143 of the `built-ins/Date` gap rows were host-lane passes. Three
root causes covered 89 of them; the fixes flip **`built-ins/Date` 397 → 486
host-free** locally with zero Date-dir or equality-suite regressions.

### 1. The BULK was NOT missing brand checks — it was `NaN === NaN` (≈68 rows)

The measured "assert #2 fails" signature on the getter rows was misleading:
#3219 had already landed the reflective getter brand checks. The actual
failure was in the **harness comparison itself**: `assert.sameValue(x, NaN)`
rides `isSameValue`'s `a !== a` NaN probe through `any` params, and the
standalone `__extern_strict_eq` `ref.eq` identity fast path (#2734/#3236 S2)
answered `true` for the SAME `$BoxedNumber` reference holding NaN. §7.2.16
IsStrictlyEqual → Number::equal (§6.1.6.1.13) makes `NaN === NaN` false even
for one identical reference. Fix (any-helpers.ts): exclude `$BoxedNumber`
from the identity short-circuit — a same-ref non-NaN box falls through to
the tag-3 `f64.eq` arm and stays `===`; object identity and the `$BigInt`
arm are untouched (neither can hold NaN). One conditional flipped every
`this-value-invalid-date` getter/setter row, `S15.9.3.1_A2/A3/A4/A6`,
`UTC/nans|infinity-*|no-arg`, `year-zero`, `parse/*` NaN rows, …

### 2. Reflective setter/toISOString closures (date-reflective-setters.ts)

`Date.prototype.set*.call(recv, …)` fell to the legacy value-erased `.call`
lowering (no §21.4.4.20–27 step-1 `thisTimeValue` TypeError, no mutation on
a genuine Date). New module mints real closure bodies via the SHARED
`emitReceiverBrandCheck` (#3171/#3192 — the one-preamble shape this issue
asked for) + the same i64 timestamp arithmetic as the direct-call kernel:
[[DateValue]] read before L→R `__to_primitive`+`__unbox_number` ToNumber
(no Date-local ToPrimitive copy), runtime absent-arg detection (the
reflective ABI null-pads missing args), §21.4.1.31 TimeClip, §21.4.4.21
setFullYear invalid-receiver re-validation. `toISOString` gets brand check +
RangeError-on-Invalid + `__date_iso_string`. Flips all setter
`this-value-non-date`/`this-value-non-object` rows + `toISOString` receiver
rows (`15.9.5.43-0-6/7/16`…).

### 3. `toLocale{,Date,Time}String.length` = 0 (§21.4.4.38–40) — 3 rows.

### Residuals (out of scope here, with verified root causes)

- **`arg-*-to-number` (≈16 rows, "returned 4")**: NOT a Date bug. The
  `thisValue === arg` assert fails only when both sides cross a CALL-ARG
  boundary into `any` params — same-object identity is lost across the
  arg-marshaling (`eq(captured, o)` → false while inline `captured !== o`
  → equal). Overlaps the in-flight #3037/#3053 identity-carrier work; do
  not double-fix. (Also pre-existing on main: `eq(o, o)` with
  `o: any = {x:1}` traps `illegal cast`.)
- **`Symbol.toPrimitive` (14 rows)**: needs symbol-keyed member VALUE reads
  on the native Date proto + a §21.4.4.45 body (is-Object check, hint
  parse, OrdinaryToPrimitive — skip @@toPrimitive lookup).
- **`toJSON` (6 rows)**: §21.4.4.37 generic ToObject + Invoke(O,
  "toISOString") machinery.
- **`value-to-primitive-*` / `coercion-order` ctor rows**: three distinct
  gaps — (a) toString-only objects coerce to NaN (`+{toString(){return
  "7"}}` → NaN; the #2891 valueOf→toString fallthrough doesn't cover closed
  anon structs), (b) single-arg `new Date(value)` never re-dispatches a
  RUNTIME string ToPrimitive result to `__date_parse` (§21.4.2 step 3.b),
  (c) own `@@toPrimitive` on the ARGUMENT isn't consulted.
- **`toISOString/15.9.5.43-0-5/11/12` (3 rows)**: blocked by a GENERAL
  standalone gap — primitive-string bracket indexing is broken
  (`"XYZ"[2]` → garbage ref; `charAt` works). Deserves its own issue;
  fixing it is worth more rows than Date.
- `S15.9.4_A1/2/3/5`, `constructor/prop-desc`: Date-constructor object
  surface (`Date.hasOwnProperty("prototype")` etc.).
