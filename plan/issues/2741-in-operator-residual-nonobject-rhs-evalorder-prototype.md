---
id: 2741
title: "`in` operator residual: non-object RHS TypeError, RHS-reference evaluation order/ReferenceError, prototype-chain membership"
status: done
assignee: ttraenkler/dev1
completed: 2026-06-27
sprint: 67
created: 2026-06-27
updated: 2026-06-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
es_edition: ES3
language_feature: relational-in
goal: test262-conformance
depends_on: []
---
# #2741 — `prop in obj` relational operator residual

The `RelationalExpression : RelationalExpression in ShiftExpression` operator
(ES2023 §13.10.1) has **~7 fixable `language/expressions/in` fails** on the
current main baseline. (Excludes ES2022 private-field `#x in obj` and
`yield`/`await`-RHS variants — those route to class-fields / generator work, not
this issue.)

## Failing test262 files (current main)

**(a) Non-object RHS must throw `TypeError`** (`If Type(rval) is not Object,
throw a TypeError exception`) — we do not throw for a primitive RHS:
- `test/language/expressions/in/S11.8.7_A3.js` (`"toString" in true` → TypeError)

**(b) RHS reference evaluation order — the RHS is evaluated (and may throw
`ReferenceError`) after the LHS; we currently throw `Test262Error`/evaluate in
the wrong order:**
- `test/language/expressions/in/S11.8.7_A2.4_T1.js`
- `test/language/expressions/in/S11.8.7_A2.4_T2.js`
- `test/language/expressions/in/S11.8.7_A2.4_T3.js` (expects `ReferenceError`)
- `test/language/expressions/in/S11.8.7_A2.4_T4.js` (`NUMBER is not defined`)

**(c) `in` must consult the prototype chain (`[[HasProperty]]`, not own-only):**
- `test/language/expressions/in/S11.8.7_A4.js` (`"Infinity" in object` after a
  property is set on the object)
- `test/language/expressions/in/S8.12.6_A2_T2.js` (inherited proto property
  `phylum` visible via `in`)

## Acceptance criteria (RE-SCOPED, dev1 2026-06-27)

Verify-first deep-probing each of the 7 tests showed the original "≥6 of 7" was
optimistic — only **3 are cleanly dev-tractable**; the other 4 converge on
substrate tracked elsewhere (see Residual). Re-scoped to the spec-correct,
broadly-beneficial subset:

- ✅ `S11.8.7_A3.js`: `key in primitive` throws **TypeError** (§13.10.1 step 5).
- ✅ `S11.8.7_A2.4_T2.js`: LHS evaluated before RHS (`x() in y()` throws "x").
- ✅ `S11.8.7_A2.4_T3.js`: unresolvable LHS identifier throws **ReferenceError**
  before the RHS runs.
- No regression in currently-green `in` tests (equivalence suite verified green;
  the 11 tagged-template equiv fails are pre-existing / unrelated — TS2345).

## RESOLVED (dev1 2026-06-27) — primitive-RHS TypeError + LHS-before-RHS eval order

Two clean, spec-correct fixes (valuable to `in` semantics broadly, not just these
3 files):

1. **`src/compiler.ts`** — `isInOperatorOperandDiagnostic`: downgrade the TS2322
   raised on an `in` operand (RHS object / LHS PropertyKey). `in` is a RUNTIME
   operation (§13.10.1; `language/expressions/in/*` has no `negative` phase), so a
   primitive RHS / non-PropertyKey LHS is not a static error. Mirrors the #2616
   Proxy-handler-trap 2322 downgrade. Tightly scoped to a 2322 inside the `in`
   BinaryExpression's LHS/RHS operand range.
2. **`src/codegen/binary-ops.ts`**:
   - `inRhsIsExclusivelyPrimitive(rightType)` → emit a runtime **TypeError throw**
     when the RHS type is exclusively a non-object primitive (number/string/
     boolean/bigint/symbol/null/undefined). `any`/`unknown`/`never`/object/union-
     with-object defer to the runtime `__extern_has` `[[HasProperty]]` path.
   - The two `__extern_has` arms now evaluate the **LHS (key) BEFORE the RHS
     (object)** (steps 1-4): key → temp, then object, then re-push key so the call
     stays `(obj, key)`. Uses `coerceType` (not a bare `extern.convert_any`) so a
     non-ref key (`Infinity` → f64) is boxed via `__box_number`.
   - **Hardening:** the struct-field-key path is gated to a ref-like key
     (string/externref/anyref). A value-typed key (number/boolean → f64/i32) on a
     struct receiver previously fed a malformed `__str_eq` (invalid module
     "call expected externref, found f64"); such keys — newly reachable now that
     the ToPropertyKey 2322 is downgraded — fall through to a defined boolean.

Tests: `tests/issue-2741.test.ts` (10). `tsc --noEmit` clean; equivalence suite
green.

## RESIDUAL (verified-blocked — substrate convergence, NOT separate issues)

The other 4 `in` fails bottom out in substrate already tracked; consolidated here
rather than scattered into new issues (lead guidance 2026-06-27):

- **`S11.8.7_A2.4_T1.js`** — `var NUMBER = 0; NUMBER = Number; … in NUMBER`. The
  f64 var slot cannot hold an object; with the spec-correct primitive-RHS throw it
  now throws TypeError (NUMBER is f64 at runtime in our rep). Needs **var
  re-slotting → value-representation substrate**.
- **`S11.8.7_A2.4_T4.js`** — undeclared `NUMBER = Number` (test is `noStrict`,
  expects an implicit global). The compiler is always-strict ESM with no
  sloppy-mode implicit-global creation → **global-object model** (the #2726 a/b
  convergence, routed to architect).
- **`S11.8.7_A4.js`** Infinity/undefined keys — `object.Infinity = 1` (dot)
  promotes the `{}` to a WasmGC struct, so a non-string key needs ToString + a
  struct-aware has-check. The `{}`+dynamic-prop representation is the blocker →
  **object-model (#2580 / #2660)**. (true/null keys DO pass via the externref
  path.)
- **`S8.12.6_A2_T2.js`** — the `in` (prototype-chain) part works, but the test
  also asserts `r.hasOwnProperty("phylum") === false`, and `hasOwnProperty`
  wrongly reports an inherited (reassigned-prototype) property as own → **separate
  hasOwnProperty / proto-chain bug (#2739 / #2747 area)**.

## Notes
- Spec: ES2023 §13.10.1 `in` operator; `[[HasProperty]]` §10.1.7.
- `language/expressions/in/private-field-*` (ES2022) and `rhs-yield*` /
  `rhs-await*` are intentionally **out of scope** for this issue.
