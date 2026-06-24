---
id: 2652
title: "Standalone: parseInt/parseFloat must ToString a non-string primitive arg"
status: done
completed: 2026-06-25
assignee: ttraenkler/agent-a2bb2065788d7244b
sprint: 66
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: number-parse
language_feature: global-functions
goal: standalone-mode
parent: 2160
related: [2600, 2644, 2648]
---

# #2652 — Standalone parseInt/parseFloat ToString of primitive arguments

## Problem

In `--target standalone` (and `--target wasi`), `parseInt(x)` / `parseFloat(x)`
crashed with **`illegal cast in parseInt()`** whenever the argument `x` was a
**non-string primitive** — a boolean, a number, `undefined`, or `null`. Per
§19.2.5 step 1 / §19.2.4 step 1 the argument must first be run through
`ToString`, then parsed:

- `parseInt(true)` → `ToString(true)="true"` → no digits → `NaN`
- `parseInt(-1)`   → `ToString(-1)="-1"`     → `-1`
- `parseInt(undefined)` / `parseInt(null)` → `"undefined"` / `"null"` → `NaN`

### Verified host-pass / standalone-fail (per-process, main `669600612e6`)

| call (arg's own static type) | host | standalone (before) |
|---|---|---|
| `parseInt(true)` (boolean) | `NaN` | **illegal cast** (trap) |
| `parseInt(-1)` (number) | `-1` | **illegal cast** (trap) |
| `parseInt(undefined)` | `NaN` | **illegal cast** (trap) |
| `parseFloat(true)` | `NaN` | **illegal cast** (trap) |
| `parseFloat(undefined)` | `NaN` | **illegal cast** (trap) |

A string arg (`parseInt("42")`, `parseInt("0x10")`) already worked.

Test262 rows landed (host-pass / standalone-fail → pass):
`built-ins/parseInt/S15.1.2.2_A1_T1` (boolean), `…_A1_T2` (number),
`…_A1_T3` (undefined/null); `built-ins/parseFloat/S15.1.2.3_A1_T1` (boolean),
`…_A1_T3` (undefined/null). **5 rows.**

## Root cause

The native `parseInt` / `parseFloat` helpers (`src/codegen/parse-number-native.ts`)
have signature `(externref, f64) -> f64` and start by doing
`local.get 0; any.convert_extern; ref.cast $AnyString` — i.e. they assume the
externref argument already wraps a native string. In JS-host mode the `env`
import does `String(arg)` itself, so a boxed boolean/number is fine. In
standalone/WASI the call site (`src/codegen/expressions/calls.ts`, global
`parseInt`/`parseFloat` arm) boxed a non-string primitive as
boolean (`__box_boolean`) / number (`__box_number`) / a raw ref, which then
failed the internal `ref.cast $AnyString` ("illegal cast").

## Fix

Two narrow, `noJsHost`-gated edits (host mode byte-for-byte unchanged):

1. **`src/codegen/expressions/calls.ts`** (global parseInt/parseFloat arm): under
   `ctx.standalone || ctx.wasi`, when the argument is a scalar (i32/f64/i64),
   void, or a statically-`null`/`undefined`/`void`-typed externref, run it
   through the existing native ToString engine `emitToString(...)` (the SAME
   helper the `+`/template sites use: boolean→"true"/"false", numeric→
   `number_toString`, null/undefined→literal) and hand the resulting native
   string ref to the helper as an externref (`extern.convert_any` via
   `coerceType`). A real string arg and a dynamic `any` wrapper object keep the
   existing passthrough (the wrapper-object cases — Boolean/Number/String object
   receivers, `…_A1_T4/T5/T6`, `…_A4/A5` — are the deferred wrapper substrate,
   out of scope here).

2. **`src/codegen/declarations.ts`** (parse import pre-scan): pre-register the
   engine helpers/literals lowering will need so no late module-function shift
   is forced mid-body — numeric arg → `number_toString`; boolean → "true"/"false";
   undefined/void → "undefined"; null → "null".

**Coercion engine reuse only** — `emitToString` / `coerceType`, no new
hand-rolled ToString matrix. The `#2108 check:coercion-sites` baseline ticks
`declarations.ts` 19→20 for the 13th instance of the already-sanctioned
`primitiveNeeded.add("number_toString")` pre-registration pattern (refreshed).

## Deferred (out of scope, noted for follow-up)

- **`parseFloat(".01e+2")` string-exponent bug** — `built-ins/parseFloat/
  S15.1.2.3_A1_T2` still fails in standalone, but on the **string-parsing** path
  (`parseFloat(".01e+2")` returns the wrong value), a PRE-EXISTING native
  parseFloat leading-dot-mantissa-with-positive-exponent bug independent of this
  change. `parseFloat("1e2")` / `parseFloat(".5e1")` work.
- Wrapper-object args (`new Boolean(true)`, `new Number(-1)`, `new String("-1")`,
  and the `valueOf`/`toString` object cases A4/A5) — the deferred
  builtin-wrapper-as-value / object→primitive substrate (#2160 / #2580 M2).

## Test Results

`tests/issue-2652.test.ts` — host + standalone + wasi all green. Per-process
test262 re-scan of the parseInt/parseFloat lane (109 files): gaps 21 → 16
(net **+5 rows**, 0 regressions).
