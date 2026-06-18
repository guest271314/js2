---
id: 2160
title: "Standalone String/Number method & coercion conformance residual (~635 tests)"
status: ready
sprint: 63
created: 2026-06-15
updated: 2026-06-18
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

## Sub-slice (dev-strnum) — `String()` array→primitive coercion (PR #1640, String-only)

`String([1,2,3])` null-dereffed in standalone. **Root cause:** the `String()`
builtin handler (`src/codegen/expressions/calls.ts`, the `funcName === "String"`
block) routes a ref/array argument through the generic `coerceType` ref→string
path, which has no array case — arrays aren't classes with `valueOf`/`@@toPrimitive`
funcMap entries, so it null-derefs. `[1,2,3].toString()` already lowers natively
via `compileArrayJoinNative`. **Fix (additive, no shared-coercion-engine change):**
a `tryEmitArrayToStringNative` helper synthesizes `arg.toString()` and dispatches
through `compileArrayMethodCall` BEFORE the coerceType fall-through. Covers
numeric/string arrays + empty typed arrays; **boolean-element arrays are
intentionally skipped** (the join path packs them i8 and synthetic-dispatch
element-type resolution diverges — they fall through with no regression).
Verified standalone/WASI; gc/host mode untouched (guard is `nativeStrings`-only).
Test: `tests/issue-2160-array-coercion-standalone.test.ts`.

**`Number(array)` deferred to senior-dev/engine:** the `Number(arr)` half
(ToNumber(ToString(arr)) per §7.1.4 → §7.1.1.1) must route string→number through
the **#1917 single coercion engine**, not a hand-rolled `__str_to_number` call
site — the Coercion-site drift gate (#2108) rejects a new ad-hoc site (18→19).
Tracked separately as a senior-dev task.

---

## Senior-dev slice (2026-06-18, sdev-proxy3) — `Number(array)` coercion

**Landed.** The `Number(arr)` half deferred by PR #1640 (the String-only array
coercion). `Number(arr)` is §7.1.4 ToNumber → §7.1.1.1 ToPrimitive(no hint) on an
Array → `arr.toString()` → §7.1.4.1 StringToNumber. Standalone has no host
`__unbox_number` and the generic struct-ToPrimitive path has no array case, so
`Number([5])` / `Number([42])*2` / `Number(["7"])` all silently yielded NaN.

**Fix (no new coercion site — respects the #2108 drift gate):** in the
`Number()` handler (`expressions/calls.ts`), reuse the two EXISTING sanctioned
lowerings — `tryEmitArrayToStringNative` (PR #1640's array→native-string) to get
the string ref, then the **existing** `__str_to_number` engine helper. The
string-ref `Number(str)` arm and the new array arm now share a single
`emitStrRefToNumber` closure holding the ONE `__str_to_number` call, so the
coercion-sites gate count for calls.ts is unchanged (18→18). Standalone /
nativeStrings only; host mode keeps `__unbox_number`.

**Scope guard (pre-existing, NOT regressed):** a bare `Number([])` literal infers
`never[]`, which the native array-join mishandles exactly like the pre-existing
`String([])` / `[].toString()` bare-literal crash. The new path is gated on a
concrete (non-`never`) element type, so `Number([])` falls through to main's NaN
behaviour (no crash). A *typed* empty array (`const a: number[] = []`) lowers
correctly → `""` → 0.

**Validation.** `tests/issue-2160-number-array-coercion.test.ts` (14/14):
single/multi/string-element/fractional/negative/zero arrays, arithmetic chains,
typed-empty → 0, multi-element → NaN, the bare-`[]` no-crash guard, and
non-array `Number()` no-regression. 35/35 across all four #2160 suites. tsc +
prettier + coercion-sites (#2108) + any-box gates clean. No host-import leak
(pure standalone). This closes the `Number(arr)` engine-routing residual; the
remaining #2160 bulk (wrapper objects `new String`/`new Number`) stays gated on
value-rep #2072/#2104.
