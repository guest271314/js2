---
id: 3216
title: "Standalone: __any_to_string renders boxed numbers/booleans as \"[object Object]\" when it is the first number-stringifier in a module (reflective String.prototype.<m>.call(<primitive>))"
status: done
assignee: ttraenkler/opus-substrate
created: 2026-07-13
updated: 2026-07-13
completed: 2026-07-13
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen
language_feature: string-coercion
goal: standalone
sprint: 71
horizon: m
related: [2875, 2860, 2979, 1961]
umbrella: 2860
loc-budget-allow:
  - src/codegen/native-strings.ts
---

# Standalone: `__any_to_string` bakes "[object Object]" for boxed primitives when it is the first number-stringifier (build-ordering)

## Corrected root cause (supersedes the #2979 residual diagnosis)

PR #2979 (reflective `String.prototype.{trim,trimStart,trimEnd}` bodies) flagged
a residual it attributed to the `any === any` string-value-read substrate:
*"`.call(<primitive>)` returns the correct trimmed string but fails
`assert.sameValue` because a primitive-coerced string externref isn't recovered
as a native string by the `any === any` path — `String(false) === "false"` fails
identically standalone."*

**That diagnosis is incorrect.** Verified on current main:

- `String(false) === "false"` **passes** standalone (both via the compiled
  test262 harness `assert_sameValue`/`assert_sameValue_str` — which box `any`
  params to `$AnyValue` and route through the content-aware `__any_strict_eq` —
  and via the static-string path). The only inline shape that mis-compares is
  two **unboxed native-string refs** typed `any` (`("x" as any) === ("x" as any)`
  → `ref.eq` identity), which the test262 harness never produces. So the
  `any === any` equality path is **not** the blocker.

- The real failure: inside the reflective method body, `ToString(this)` renders
  a boxed **primitive** `this` as `"[object Object]"`.
  - `String.prototype.charAt.call(12345, 2)` reads `"[object Object]"[2]` (`'b'`,
    charCode 98) instead of `"12345"[2]` (`'3'`, charCode 51). **Reproduces on
    pristine main today** (charAt/charCodeAt bodies already exist).
  - `String.prototype.trim.call(0)` returns `"[object Object]"` (len 15) instead
    of `"0"` (needs #2979's trim body to compile first).

### The exact mechanism (build-ordering)

`__any_to_string`'s number arms — the tag-2 / tag-3 `$AnyValue` dispatch arms
**and** the residual `$__box_number_struct` recovery arm — are built via
`numberArm(...)`, which bakes `number_toString` **if it is registered at build
time**, else the literal `"[object Object]"`. `__any_to_string` is built once and
cached.

When the **first** `__any_to_string` consumer in a module is a reflective
`String.prototype.<m>.call(<number|boolean>)` body's `ToString(this)`,
`number_toString` has not yet been registered, so `numToStrIdx === undefined` and
**every** number arm bakes `"[object Object]"`. The cached helper then
mis-stringifies boxed primitives for the whole module. Other consumers (array
`join`, `String(x)`, template literals) pull `number_toString` in first, which is
why they work and masked this ordering hazard.

Diagnostic (env `JS2WASM_DIAG_A2S`) at `__any_to_string` build time:
- reflective `charCodeAt.call(12345,0)` module → `number_toString_registered=false` → "[object Object]"
- array `[12345].join("")` module → `number_toString_registered=true` → "12345"

## Fix (landed here)

`src/codegen/native-strings.ts` `ensureAnyToStringHelper`: register the native
`number_toString` (via `emitNativeNumberFormat(ctx, new Set(["number_toString"]))`)
**before** any funcIdx is captured in the helper, so its number arms always bake
the real conversion. Idempotent + append-only defined function; placed before the
`errToStrIdx`/`numToStrIdx` captures so any #1448 string-constant late-import
shift precedes them. **Gated on `ctx.nativeStrings`** so host/gc lanes stay
byte-identical (there `number_toString` is host-provided/absent and the numberArm
keeps its prior fallback).

### Verified
- `String.prototype.charCodeAt.call(12345, 0)` → 49 (`'1'`), was 91 (`'['`).
- `String.prototype.charAt.call(12345, 2) === "3"` → true, was false.
- `String.prototype.charCodeAt.call(true, 0)` → 116 (`'t'`).
- Controls unchanged: `join`, `String(x)`, templates, `Number.toString(radix)`,
  `String(NaN)`.
- Regression: 246-file `String/prototype/{charAt,charCodeAt,codePointAt,trim*}`
  standalone corpus — **0 per-file flips** branch vs pristine-main control; broad
  smoke identical to control.

## Measured test262 yield: ~0 direct (prerequisite fix)

This fix does **not** independently flip test262 rows, because the test262
tests that would exercise it fail on **two adjacent bugs still open** (see
below). It is a **prerequisite** that unblocks them once those land.

## Follow-on bugs (scoped intel — NOT fixed here; opus-standalone / #2875 lane)

1. **Reflective arity-0 `.call(<primitive>)` `this`-boxing** (trim family, #2979):
   `String.prototype.trim.call(0)` still renders `"[object Object]"` **with this
   fix applied**. Pinned (sentinel): trim's `this` does NOT reach
   `__any_to_string`'s `$__box_number_struct` residual arm — the arity-0
   reflective `.call` boxes the primitive `this` as a `$AnyValue` object (tag-6),
   not a `$__box_number_struct`, so no number arm fires. This is in the reflective
   `.call` this-argument coercion (`src/codegen/expressions/calls.ts`
   `emitReflectiveNativeProtoClosureCall`) / #2979's arity-0 body, not
   `__any_to_string`.

2. **Number/Boolean wrapper-object receiver** (the actual test262 charAt shape,
   e.g. `built-ins/String/prototype/charAt/S15.5.4.4_A1_T1.js`):
   `var o = new Object(42); o.charAt = String.prototype.charAt; o.charAt(0)` still
   fails — the `new Object(<primitive>)` wrapper receiver's `ToString` is not
   recovered to its primitive. Separate `$Object` primitive-wrapper value-read.

Landing #2979 + fix (1) + fix (2) together flips the
`String/prototype/{charAt,charCodeAt,codePointAt,trim*}` reflective-/wrapper-over-
primitive rows.

## Also noted (unrelated, pre-existing on main — not this issue)
- Inline `("x" as any) === ("x" as any)` → `ref.eq` (identity) instead of content
  eq — two unboxed native-string refs typed `any` in a strict-eq
  (`binary-ops.ts` `leftIsRef && rightIsRef` arm falls to `ref.eq`; only
  `$AnyValue` boxes route to `__any_strict_eq`). §7.2.16 violation, but the
  test262 harness never produces this shape (it boxes to `$AnyValue`). Low yield;
  precedent #1961 (the `string|undefined` analogue).
