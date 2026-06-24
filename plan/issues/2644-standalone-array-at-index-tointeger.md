---
id: 2644
title: "Standalone: ToIntegerOrInfinity for Array.prototype.at index arg"
status: done
completed: 2026-06-24
assignee: ttraenkler/agent-abc4cbcc1c297d4bd
sprint: 65
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: conformance
area: array-number
language_feature: array-methods
goal: standalone-mode
parent: 2160
related: [2600, 2124]
---

# #2644 — Standalone Array.prototype.at index argument ToIntegerOrInfinity

## Problem

In `--target standalone`, the index argument of `Array.prototype.at` was coerced
**directly to i32** instead of through **ToIntegerOrInfinity** (§23.1.3.1 step 2 =
§7.1.5 = ToNumber then truncate-toward-zero). So a non-integer-typed index on a
**typed array receiver** resolved to the wrong slot — a substrate-independent
value-correctness bug (not a trap).

This is the **Array analog** of the already-fixed String-method bug #2600
(`compileStringIntegerArg`).

### Verified repro (host pass / standalone wrong-value, main `4c0582635c`)

| call (typed `number[]` receiver, `a=[10,11,12,13]`) | host | standalone (before) |
|---|---|---|
| `a.at("1")` | `11` (ToInteger("1")=1) | **`10`** (index 0) |
| `a.at("2")` | `12` | **`10`** |
| `a.at("-1")` | `13` | wrong |

Per-process probe (direct standalone compile+run) confirmed `a.at("1")` → 10.
`a.at(true)` / `a.at(false)` / numeric literals already worked (they reach an
i32/f64 path); only the **string / object** index fell through to 0.

The matching test262 row `built-ins/Array/prototype/at/index-non-numeric-argument-tointeger.js`
was host-pass / standalone-fail (failed at assertion #9, `a.at("1")`).

## Root cause

`compileArrayAt` (`src/codegen/array-methods.ts` ~line 3805) requested the index
with a direct `{ kind: "i32" }` hint:

```ts
const argType = compileExpression(ctx, fctx, callExpr.arguments[0]!, { kind: "i32" });
if (argType && argType.kind === "f64") fctx.body.push({ op: "i32.trunc_sat_f64_s" });
```

In standalone, `compileExpression(stringLiteral, {kind:"i32"})` does not run
ToNumber(string)→truncate; it falls through to 0. (Host has a JS import path that
coerces correctly.)

## Fix

`src/codegen/array-methods.ts`, `compileArrayAt` — under `noJsHost(ctx)` the index
is now run through ToIntegerOrInfinity, mirroring #2600:

- `i32`-typed arg → unchanged (already integral, in range).
- `i64` (bigint) → TypeError via `emitThrowString` (§7.1.4).
- else → `coerceType(argType, {kind:"f64"}, "number")` (the existing numeric
  engine: string → `__str_to_number`, object → ToPrimitive("number")), then
  ToIntegerOrInfinity: NaN→0 (`f64.ne self` test), else `i32.trunc_sat_f64_s`
  (truncates toward zero; ±∞ saturates and the following negative-wrap +
  bounds-check clamp it).

The legacy direct-i32 path is kept for the JS-host mode. **No new #2108 coercion
site** — `coerceType` reuse only; `check:coercion-sites` baseline unchanged. The
negative-index wrap and bounds-check logic in `compileArrayAt` are downstream of
the produced `idxTmp` and untouched.

## Test Results

- `tests/issue-2644-array-at-index-tointeger.test.ts` — 14/14 pass (standalone +
  gc-mode regression guards): `at("1")`→11, `at("2")`→12, `at("1.9")`→11,
  `at("")`→10, `at("abc")`→10 (NaN→0), `at("-1")`→13, `at("-2.5")`→12,
  `at(true)`→11, `at(false)`→10, numeric `at(2)`/`at(-1)`/`at(1.9)` unchanged,
  gc-mode `at("1")`/`at(2)` guards green.
- test262 `built-ins/Array/prototype/at/index-non-numeric-argument-tointeger.js`
  flips standalone fail→pass; host still pass.
- Full `Array/prototype/at` dir (13 host-passing files): 0 standalone gaps after
  the fix (was 1).
- tsc, lint, prettier, `check:coercion-sites`, `check:stack-balance`,
  `check:any-box-sites`, `check:codegen-fallbacks`, `check:speculative-rollback`
  all green. native-arrays.test.ts pre-existing failures (15, TS semantic
  diagnostics) confirmed identical with/without this change.

### Estimated rows
~1 standalone row (`index-non-numeric-argument-tointeger.js`).
