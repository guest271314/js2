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

## Architect scope-read (esch, 2026-06-27) — SPLIT (a) from (b); (b) depends on #2712

Re-verified on current `origin/main` HEAD (f51590644910a) via the real
`runTest262File` runner. **(a) and (b) have DIFFERENT root causes and must NOT be
dispatched as one task.**

**(a) unary `+`/`-`/`~`/`>>>` on object → REAL, still traps.** All 5 listed tests
`fail` with **"dereferencing a null pointer in test()"**. (Note: a *simple*
`+{valueOf(){return 1}}` probe returns 1 — the trap is on the FULL OrdinaryToPrimitive
fallback chain the tests exercise: `valueOf` returns an object → must fall to
`toString`; `toString` throws → must propagate; `valueOf`-only / `toString`-only.) The
unary lowering reads a numeric field off the operand ref before coercing, null-derefing
on a non-number object. **This is a self-contained ToNumber/ToPrimitive-in-numeric-
context codegen gap — architect-spec-able and dev-implementable independently of #2712.**
Spec target: the unary numeric lowering must call ToPrimitive(operand, Number)
(valueOf→toString, §7.1.1) BEFORE extracting the f64/i32, when the operand is a
non-primitive ref. This is the higher-value, independently-shippable half.

**(b) strict-equals — NOT a trap; it is the boolean-as-i32 representation collision →
DEPENDS ON #2712.** The 6 strict-(in)equals tests fail at assertion **#2: `true === 1`**
(must be `false` per §7.2.16 step 1, Type(boolean) ≠ Type(number)). The compiler
returns `true` because boolean `true` and number share the i32 `1` representation —
confirmed directly: `false === 0` evaluates `EQ` (wrong) on current main. The original
"traps with a WebAssembly.Exception" framing is stale — it now mis-VALUES, not traps.
**This cannot be fixed cleanly without a value-rep way to distinguish boolean from
number, which is exactly #2712 (real bool ValType).** Recommend: re-scope (b) as
blocked-on / folded-into #2712; do NOT dispatch (b) as an independent operator patch
(a localized strict-eq tag check would re-encode the same brand fragility #2712
retires). The `new Boolean(...)`/`new Number(...)`/`new String(...)` boxed-wrapper
cases (#1/#3/#5) are downstream of the same primitive-tag gap.

**Recommended action:** keep (a) in this issue (architect-spec the ToPrimitive unary
path; dev-able). Move (b) to depend on #2712 (or carve a `#2732b` blocked-on-#2712).
Acceptance "9 of 11" is not reachable while (b) is blocked — (a) alone is the 5 unary
tests.
