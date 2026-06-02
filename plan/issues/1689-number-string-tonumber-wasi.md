---
id: 1689
title: "Number(string) returns 0 under --target wasi — missing native StringToNumber"
status: done
created: 2026-05-27
updated: 2026-05-27
completed: 2026-05-27
priority: medium
feasibility: medium
task_type: bugfix
area: codegen, standalone
language_feature: numbers, string-to-number
goal: standalone-mode
sprint: Backlog
related: [1663, 1471, 1335]
---
# #1688 — `Number(string)` returns 0 under `--target wasi`

> Renumbered from #1685 (ID collision with the wont-fix Symbol→string
> coercion issue, which already owns #1685). Task tracking still references
> the original "#1685" task; the on-disk issue is #1688.

## Problem

Follow-up from #1663 (which landed native `parseInt` / `parseFloat` but, despite
its title, never implemented `Number(string)`). Under `--target wasi` /
`--target standalone`:

```ts
export function test(): number {
  const s: string = "7";
  return Number(s);     // → 0 (wrong; should be 7)
}
```

returns `0`. No JS-host import leaks (good), but the value is wrong. In JS-host
mode the same source returns `7` via the `env.__unbox_number` import.

## Root cause

Under native strings (auto-on for WASI/standalone) a `Number(string)` argument
is a **WasmGC string ref** (`ref $AnyString`/`$NativeString`), not an
`externref`. In `src/codegen/expressions/calls.ts` the `Number(x)` handler only
had a native path for the `externref` arg shape (host `__unbox_number`); a
string *ref* fell through to the generic `ref → f64` struct-ToPrimitive path in
`type-coercion.ts`, which has no string case and silently emits `f64.const 0`
(it drops the ref and pushes 0 via the host `__to_primitive` no-op + native
`__unbox_number` fallthrough).

## Fix

1. **`src/codegen/parse-number-native.ts`** — new pure-Wasm `__str_to_number`
   helper implementing ECMA-262 §7.1.4.1 StringToNumber: flatten → trim leading
   and trailing whitespace → empty/all-whitespace ⇒ `0` → `Infinity` (full
   match) → `0x` hex integer literal → signed decimal mantissa/fraction/exponent
   with a **full-match-or-NaN** requirement (differs from parseFloat's
   longest-prefix). Reuses the existing `emitExponent` / `emitApplyExp` /
   `emitDigitValue` / `isWsBody` sub-emitters.
2. **`src/codegen/declarations.ts`** — when `Number` is referenced under
   `ctx.nativeStrings`, add `__str_to_number` to `parseNeeded` so it is emitted
   upfront alongside parseInt/parseFloat (no mid-body function registration that
   would shift func indices).
3. **`src/codegen/expressions/calls.ts`** — the `Number(x)` `ref`/`ref_null`
   branch now detects a native-string struct type
   (`anyStrTypeIdx`/`nativeStrTypeIdx`) and routes it through `__str_to_number`
   (`extern.convert_any` + call) before the generic struct path.

## Known limitation

Only the `0x` hex prefix is recognised; `0o`/`0b` NonDecimalIntegerLiterals
return NaN rather than their value. Decimal, hex, fraction, exponent, sign,
whitespace trimming, `Infinity`, and empty-string semantics are all correct.

## Acceptance criteria

1. `Number("7")` / `Number(s)` returns 7 under `--target wasi`. ✓
2. No JS-host imports introduced in standalone/WASI. ✓
3. JS-host mode `Number(string)` unchanged. ✓
4. Focused test `tests/issue-1685.test.ts`. ✓

## Test Results

`tests/issue-1685.test.ts` — 9 tests, all pass (integer, literal, whitespace
trim, empty → 0, fraction/exponent, signed, hex, Infinity, NaN trailing-junk).
No regression: `tests/wasi.test.ts` (24) + `tests/issue-1663.test.ts` (15) green.
