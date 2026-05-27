---
id: 1604
title: "codegen: String case methods (toUpperCase/toLowerCase/toLocale*) return i32 into f64 comparison — invalid wasm"
status: done
created: 2026-05-24
updated: 2026-05-27
completed: 2026-05-27
priority: high
feasibility: medium
task_type: bugfix
area: codegen
language_feature: string-methods
goal: compiler-correctness
sprint: 56
es_edition: multi
test262_count: 8
related: [1105, 1522]
---
# #1604 — String case-conversion method result type mismatch

## Problem

8 test262 tests fail with `invalid Wasm binary`:

```
f64.ne[0] expected type f64, found call of type i32
```

All 8 are `built-ins/String`, specifically the case-conversion methods:
`toUpperCase`, `toLowerCase`, `toLocaleUpperCase`, `toLocaleLowerCase`.

The compiled `test` function calls the string-case method (whose codegen emits
an `i32`-typed result — likely a string-array ref index or a stale i32 temp)
and then feeds it directly into an `f64.ne` comparison, which the validator
rejects.

## Failing test examples

- `test/built-ins/String/prototype/toUpperCase/S15.5.4.18_A1_T9.js`
- `test/built-ins/String/prototype/toUpperCase/S15.5.4.18_A1_T4.js`
- `test/built-ins/String/prototype/toLocaleUpperCase/S15.5.4.19_A1_T4.js`

## Root-cause hypothesis

The String case-method intrinsic in `src/codegen/` (string method lowering,
see #1105) declares or returns an `i32` result type where the surrounding
expression expects an `externref`/f64 string value. When the test compares the
result with `!=`, `coerceType` is not invoked (or invoked against the wrong
source type) before `f64.ne`. Audit the return-type registration of the
case-conversion methods so their result is a string ref that coerces correctly
in numeric/equality contexts.

## Acceptance criteria

- The three example tests compile to valid Wasm.
- All 8 tests move off `compile_error`.

## Resolution (2026-05-27)

The `f64.ne expected f64, found i32` **compile_error was already fixed on
main** (likely via the call-site argument coercion work in #1602): all 8 case
tests already validate to valid Wasm and sit at `fail` (not `compile_error`) in
the current baseline — acceptance criteria met.

The remaining failure was a **`wrapTest` harness bug**, not a compiler bug.
`tests/test262-runner.ts` unconditionally rewrote `__expected.index` /
`__expected.input` *reads* into the extracted variables `__expected_index` /
`__expected_input`. Those vars are only declared when the source *assigns*
`__expected.index = N` (the RegExp-exec result pattern). The case-conversion
tests only read `.index`/`.input` (both `undefined` on a plain string) and
never assign them, so the rewrite left a reference to an undeclared variable
→ `__expected_index is not defined`.

Fix: guard the read-rewrite on whether the corresponding declaration was
actually extracted; otherwise leave the property read intact (compiles to
`undefined`).

Result: **+4 tests** fail→pass (the `_T4` empty-string variants:
`toLowerCase` `S15.5.4.16_A1_T4`, `toUpperCase` `S15.5.4.18_A1_T4`,
`toLocaleLowerCase` `S15.5.4.17_A1_T4`, `toLocaleUpperCase`
`S15.5.4.19_A1_T4`). The 4 `_T9` variants stay `fail` — a separate
`new String(obj)` ToPrimitive issue (`{valueOf:fn, toString:void 0}` throwing
"Cannot convert object to primitive value"), out of scope here. RegExp-exec
result tests that *do* assign `__expected.index` (e.g. `S15.10.6.2_A*`) keep
the extraction transform and remain `pass` — no regressions.

Regression test: `tests/issue-1604.test.ts`.
