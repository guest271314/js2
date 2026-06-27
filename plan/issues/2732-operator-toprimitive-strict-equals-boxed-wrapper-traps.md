---
id: 2732
title: "operators: unary +/-/~/>>> ToPrimitive(object) trap; strict-equals boxed-wrapper/funcref trap"
status: ready
sprint: 67
goal: test262-conformance
feasibility: hard
depends_on: []
priority: medium
es_edition: ES3
language_feature: operators
task_type: bug
created: 2026-06-26
updated: 2026-06-26
---
# #2732 — operator trapping residuals (split from #2707 (a)+(b))

Split out of #2707 — the TCO portion (c) landed in PR #2159. These two
sub-bugs are independent **runtime traps** (not assertion failures) that look
like value-representation / boxed-wrapper substrate gaps, so this is
**architect-routed (feasibility: hard)**, not a quick operator-codegen tweak.

## (a) Unary `+` / `-` / `~` / `>>>` on a non-primitive operand traps

`+object` where `object = { valueOf() { return 1 } }` traps at runtime with
**"dereferencing a null pointer"** instead of performing `ToNumber` →
`ToPrimitive(object, Number)` (call `valueOf` / `toString`). The issue spec
originally framed this as "null/undefined operands", but the actual failing
test262 tests exercise `ToPrimitive` on **objects** (`valueOf`/`toString`
dispatch), which is the deeper gap — the unary lowering reads a numeric field
off the operand ref before coercing, null-dereferencing when the operand is a
non-number object.

Tests (verified to trap on main HEAD, 2026-06-26):
```
test/language/expressions/unary-plus/S11.4.6_A2.2_T1.js       (+object via valueOf/toString)
test/language/expressions/unary-minus/S11.4.7_A2.2_T1.js
test/language/expressions/bitwise-not/S11.4.8_A2.2_T1.js
test/language/expressions/unsigned-right-shift/S9.6_A3.1_T4.js
test/language/expressions/bitwise-not/S9.5_A3.1_T4.js
```
Spec: §7.1.4 ToNumber, §7.1.1 ToPrimitive (OrdinaryToPrimitive: valueOf then
toString, each via §7.3 Call; TypeError if neither returns a primitive).

## (b) `strict-equals` / `strict-does-not-equals` with a boxed wrapper / funcref traps

`true !== new Boolean(true)` (and the `new Number(...)` / `new String(...)`
variants) should be `true` (different types → §7.2.16 step 1), but the
comparison **traps with a WebAssembly.Exception** instead of short-circuiting on
the type-tag mismatch. The `#` in the original #2707 framing is a wasm funcref /
boxed-wrapper representation; the strict-equality fast path mis-handles the
boolean-primitive vs boxed-object-wrapper case.

Tests (verified to trap on main HEAD):
```
test/language/expressions/strict-equals/S11.9.4_A8_T1.js .. _T3.js
test/language/expressions/strict-does-not-equals/S11.9.5_A8_T1.js .. _T3.js
```
Spec: §7.2.16 Strict Equality Comparison (Type(x) ≠ Type(y) ⇒ return false; the
`!==` then negates).

## Why architect-routed / hard

Both are runtime traps, not wrong values — the codegen emits an op that assumes
a representation the operand doesn't have (a numeric field on a boxed/object
ref; a primitive tag on a wrapper). The fix likely needs the
boxed-wrapper / `any`-value-read substrate (see the standalone value-rep
substrate notes) rather than a localized operator patch. An architect should
spec the ToPrimitive-in-numeric-context path and the strict-eq type-tag
classifier against the boxed-wrapper representation before a dev implements.

## Acceptance criteria

At least 9 of the 11 listed tests (5 unary + 6 strict-equals) flip fail→pass,
with no regression in operator tests and full CI green.

## Notes
- BigInt operator tests remain out of scope (blocked on #2044).
- `with`-statement increment/decrement tests remain wont-fix (skip-filtered).
- TCO portion (c) of the parent #2707 is done in PR #2159.
