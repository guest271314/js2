---
id: 3217
title: "standalone: String.prototype.trim/trimStart/trimEnd reflective-call over coerced receivers (host-free native body)"
status: done
assignee: ttraenkler/opus-standalone
created: 2026-07-13
updated: 2026-07-13
completed: 2026-07-13
priority: high
feasibility: medium
task_type: bug
area: codegen
es_edition: es5
language_feature: string-methods
goal: standalone
umbrella: 2860
sprint: 71
horizon: s
loc-budget-allow:
  - src/codegen/array-object-proto.ts
related: [2860, 2875, 2885]
origin: "opus-standalone harvest of #2860 honest-gap lane diff (2026-07-13): String.prototype.trim family sub-slice of #2875, independent of #2885 descriptor core."
---

# #3217 — standalone: String.prototype.{trim,trimStart,trimEnd} reflective body

## Problem

In `--target standalone`, a reflective `String.prototype.trim.call(recv)`
(and `trimStart`/`trimEnd`) over a **non-string / coerced receiver**
(`false`, `[1]`, `undefined`, a boxed number, …) does NOT run host-free:
the reflective native-proto closure body for `trim`/`trimStart`/`trimEnd`
**refuses** (`emitProtoMemberBodyRefusal`), so the call falls through to the
legacy `.call` lowering, which for primitive / array receivers emits **invalid
Wasm** (`call[0] expected type (ref null 6), found i32.const` — 29 CE trim
tests) or an **illegal cast** (array receiver), or silently returns `null`
(wrong answer). All host-free but non-conformant.

Measured (2026-07-13, honest lane diff of #2860): the `built-ins/String/
prototype/{trim,trimStart,trimEnd}` gap is ~69 host-pass / standalone-not-pass
rows; `trim` alone had 46 non-pass files (29 compile_error + 17 fail) in the
process-isolated standalone lane.

## Root cause

`emitStringProtoMemberBody` (`src/codegen/array-object-proto.ts`) has native
reflective bodies for `charAt`/`at`/`charCodeAt`/`codePointAt` and the search
families, but `trim`/`trimStart`/`trimEnd` fall to `emitProtoMemberBodyRefusal`.
The refusal returns `null`, so `ensureStandaloneNativeMethodClosure` (invoked
WITHOUT `refusalBodyFallback` from `emitReflectiveNativeProtoClosureCall`,
calls.ts) returns `undefined` and the call site falls through to the broken
legacy path.

All infrastructure the fix needs already exists:
- String is already routed through the reflective brand map
  (`tryEmitNativeProtoReflectiveCall`, calls.ts — NOT touched by this issue).
- `emitStringProtoMemberBody` already emits the §22.1.3 preamble
  `RequireObjectCoercible(this)` (throw catchable TypeError on null/undefined)
  + `S = ToString(this)` (`__any_to_string` + `__str_flatten`) for the char
  accessors — reusable verbatim for any coerced receiver.
- Native `__str_trim` / `__str_trimStart` / `__str_trimEnd` helpers already
  exist (`src/codegen/native-strings.ts`) and back the direct `"x".trim()`
  path (already host-free-passing).

## Fix

Add a `trim`/`trimStart`/`trimEnd` arm to `emitStringProtoMemberBody`: run the
existing ROC + ToString(this) → flat-string preamble, then call the matching
`__str_trim*` helper on the flat string and box the result to externref.
`ctx.standalone`-gated by construction (the reflective-proto body path only
runs in standalone), so **zero host-mode impact**.

## Measured result (2026-07-13, process-isolated standalone lane, branch vs origin/main)

| family | control pass | branch pass | Δ pass | control CE | branch CE |
| ------ | -----------: | ----------: | -----: | ---------: | --------: |
| trim | 83 | 87 | **+4** | 29 | **0** |
| trimStart | 5 | 7 | **+2** | 1 | **0** |
| trimEnd | 5 | 7 | **+2** | 1 | **0** |
| **total** | 93 | 101 | **+8** | 31 | **0** |

**+8 host-free passes, +31 invalid-Wasm compile-errors eliminated** (broken
binaries → clean fails — a #2878 worst-class-correctness win), **zero
pass→fail regressions**. All flips are the `RequireObjectCoercible` throw cases
(`.call(undefined/null)` → TypeError) and the string-receiver cases
(`.call("  x  ")` → trimmed) — plus the 31 primitive/array/wrapper receivers
that previously emitted **invalid Wasm** now compile to a clean host-free binary.

### Residual (NOT this slice — separate substrate gap)

The remaining `.call(<boolean|number|array|String-wrapper>)` rows return the
CORRECT trimmed string but fail the test's `assert.sameValue(result, "…")`
because of a **general `__any_to_string` / `any`-equality substrate tagging
gap**: `String(false) === "false"` also fails in `any` context (verified
directly) — a primitive-coerced string externref is not recovered as a native
string by the `any === any` path, whereas a native string LITERAL is. This is
the known-hard `standalone_any_string_value_read_substrate` area, upstream of
this method-body slice and outside its lane. Filed as the follow-up that
unblocks the bulk of these rows (and the parallel `charAt`/`charCodeAt`
reflective-over-primitive residual, which share the exact path).

## Acceptance criteria

- Net-positive host-free standalone passes across
  `built-ins/String/prototype/{trim,trimStart,trimEnd}` with **zero pass→fail
  regressions** — MET (+8 pass, +31 CE eliminated).
- Sample flips:
  - `built-ins/String/prototype/trim/15.5.4.20-1-1.js` (`.call(undefined)` → TypeError) ✓
  - `built-ins/String/prototype/trimStart/this-value-not-obj-coercible.js` ✓
  - `String.prototype.trim.call("  x  ")` → "x" ✓
- Zero host-mode regressions (`ctx.standalone`-gated reflective body); zero
  standalone high-water regressions (`check-standalone-highwater.mjs`).
- One PR, one method family.
