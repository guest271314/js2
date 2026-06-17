---
id: 2160
title: "Standalone String/Number method & coercion conformance residual (~635 tests)"
status: ready
sprint: 63
created: 2026-06-15
updated: 2026-06-15
priority: high
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: standalone
language_feature: string-number
goal: standalone-mode
parent: 1470
depends_on: [1917, 2104]
---

# Standalone String/Number method & coercion conformance residual

## Problem

Wasm-native string methods and standalone number formatting landed in #1470,
#1335, #1105 (all `done`, sprints 58–61). The host-vs-standalone baseline
diff (sha `31fa7e099`, 2026-06-15) shows **635 tests pass in host mode but
fail standalone**, attributed to String/Number method and coercion residuals.

## Evidence

- Gap categories: `built-ins/String` (643), `built-ins/Number` (159),
  plus String/Number coercion in `language/expressions`.
- Partly overlaps the coercion engine (#1917) and value-rep boxing
  (#2072/#2104) work — `__new_String`/`__new_Number` wrapper boxing leaks.

## Acceptance criteria

- Standalone pass count for `built-ins/String` + `built-ins/Number` rises
  toward host parity.
- No `__new_String`/`__new_Number` host-import leak for the covered cases.
- Gap-diff repros added as standalone equivalence tests.

## Notes

Parent (done): #1470. Sequenced after the coercion engine (#1917) and
value-rep P1 (#2104). Part of sprint-62 standalone catch-up (rank 4 by gap
impact).

---

## Progress (2026-06-16, dev3) — `Number.parseInt`/`Number.parseFloat` slice

**Status stays `ready`** — this is one independent slice of the 635-test
bucket, landable now (not gated on #1917/#2104).

Re-measured against `origin/main` @ `5634b13ec`: the common String/Number
methods + coercion already pass standalone (padStart/padEnd/repeat/trim/
includes/startsWith/endsWith/at/codePointAt/replaceAll; toFixed/toPrecision/
toExponential/toString(radix); Number.isInteger/isNaN/isFinite/isSafeInteger;
bare parseInt/parseFloat; `+str`/`str*num`/`str+num` coercion; template
literals; String(num); `-0`/NaN/1e21 formatting). Many were closed by the
value-rep P0/P1 work that just landed.

**One concrete independent bug fixed (this PR):** `Number.parseInt` /
`Number.parseFloat` (the §21.1.2.12-13 namespaced aliases — same functions as
the globals) failed to compile in standalone with a `__get_builtin` codegen
error, while the bare `parseInt`/`parseFloat` worked. Root cause: the parse
import-collector (`src/codegen/declarations.ts`) only recognized the _bare
identifier_ call form, so the `Number.`-prefixed property-access form never
registered the native WasmGC scanner; the call-site routing
(`calls.ts`, which reads `funcMap.get("parseInt"/"parseFloat")`) then fell
through to the dynamic-shape `__get_builtin` refusal. Fix: detect the
`Number.parseInt`/`Number.parseFloat` call shape in the collector and add the
same helper to `parseNeeded`. Regression test:
`tests/issue-2160-number-parse.test.ts` (8 cases × host/standalone).

**Still open (the bulk of the 635):** the remaining residuals are the
**wrapper objects** `new String(...)` / `new Number(...)` (standalone null-deref
/ wrong `valueOf` — gated on value-rep boxing #2072/#2104, and noted in the
acceptance criteria's `__new_String`/`__new_Number` leak) plus the harder
String/Number coercion edges that overlap the coercion engine (#1917). Those
remain the value-rep / #1917 territory called out in the original notes.

---

## Sub-slice (dev-strnum) — `substr` lowering for standalone (PR #1627)

`String.prototype.substr` (Annex B §B.2.2.1) was not lowered for native-strings
(standalone / WASI). `compileNativeStringMethodCall` (`src/codegen/string-ops.ts`)
handled `substring`/`slice` but had no `substr` branch, so the call fell through
and trapped with a null-pointer dereference. Fix: new `__str_substr(s, start,
length)` WasmGC helper (`src/codegen/native-strings.ts`) — `substr`'s 2nd arg is
a CHAR COUNT, negative `start` counts from end — delegating to `__str_substring`,
plus a `substr` dispatch branch. Verified standalone/WASI/gc.
Test: `tests/issue-2160-substr-standalone.test.ts`.

## Sub-slice (dev-strnum) — `String()`/`Number()` array→primitive coercion

`String([1,2,3])` null-dereffed and `Number([5])`/`Number([])` returned NaN in
standalone. **Root cause:** the `String()`/`Number()` builtin handlers
(`src/codegen/expressions/calls.ts`, the `funcName === "String"` and
`funcName === "Number"` blocks) route a ref/array argument through the generic
`coerceType` ref→string/number path, which has no array case — arrays aren't
classes with `valueOf`/`@@toPrimitive` funcMap entries, so it null-derefs / NaNs.
`[1,2,3].toString()` already lowers natively via `compileArrayJoinNative`.
**Fix (additive, no shared-coercion-engine change):** a `tryEmitArrayToStringNative`
helper synthesizes `arg.toString()` and dispatches through `compileArrayMethodCall`
BEFORE the coerceType fall-through; `Number()` then runs `__str_to_number` on the
result (ToNumber(ToString(arr)) per §7.1.4 → §7.1.1.1). Covers numeric/string
arrays + empty typed arrays; **boolean-element arrays are intentionally skipped**
(the join path packs them i8 and synthetic-dispatch element-type resolution
diverges — they fall through with no regression, out of this slice's scope).
Verified standalone/WASI; gc/host mode untouched (guard is `nativeStrings`-only).
Test: `tests/issue-2160-array-coercion-standalone.test.ts`.
