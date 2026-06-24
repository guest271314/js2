---
id: 1801
title: "WASI process.exit(code) emits an invalid binary (i32/f64 stack mismatch in trunc)"
status: done
sprint: 60
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
priority: medium
feasibility: easy
reasoning_effort: low
task_type: bugfix
area: codegen
language_feature: wasi-process-exit
goal: correctness
related: [1858]
---
# #1801 — WASI `process.exit(code)` emits an invalid binary

> Renumbered from a stray `2177-*` id (see #1858 allocator-hygiene note). Example
> of the audit's "no `WebAssembly.validate()` in the pipeline → silent invalid
> binary" theme.

## Problem

Compiling `process.exit(N)` with `--target wasi` (`{ target: "wasi" }`)
reports `success: true` but produces a module that **fails
`WebAssembly.validate()`**. Instantiating it throws:

```
CompileError: WebAssembly.compile(): Compiling function #1:"__module_init"
failed: i32.trunc_sat_f64_s[0] expected type f64, found i32.const of type i32
```

Reproduces for every code value (`process.exit(0)`, `(1)`, `(42)`), with or
without a preceding `console.log`. The existing `tests/wasi-target.test.ts`
only asserts that the WAT text contains `proc_exit`, so it never exercised
binary validity and did not catch this.

```ts
const r = await compile(
  `declare const process: { exit(code: number): void }; process.exit(0);`,
  { target: "wasi" },
);
r.success;                          // true
WebAssembly.validate(r.binary);     // false  <-- bug
```

## Root cause

`src/codegen/expressions/calls.ts` (the WASI `process.exit` special case):

```ts
if (expr.arguments.length >= 1) {
  compileExpression(ctx, fctx, expr.arguments[0]!, { kind: "i32" }); // pushes i32
  const argType = ctx.checker.getTypeAtLocation(expr.arguments[0]!);
  if (isNumberType(argType)) {
    fctx.body.push({ op: "i32.trunc_sat_f64_s" } as Instr);          // expects f64
  }
}
```

The argument is compiled with expected type `{ kind: "i32" }`, so
`compileExpression` already coerces the value to an `i32` on the stack (for a
literal it emits `i32.const 0`). The code then *also* pushes
`i32.trunc_sat_f64_s`, which expects an **f64** operand — but the stack holds
an `i32`. Hence the validation failure. The `i32`-expected compile and the
`f64→i32` truncation are mutually exclusive; the code does both.

`proc_exit` itself takes an `i32` (`addFuncType(ctx, [{ kind: "i32" }], …)`,
`src/codegen/index.ts`), so the call target type is correct — only the operand
lowering is wrong. (Re-verify exact line numbers before editing.)

## Fix (one of)

1. **Drop the redundant truncation** — `compileExpression(…, { kind: "i32" })`
   already delivers an `i32`, so remove the `i32.trunc_sat_f64_s` push
   entirely. Simplest, and correct for the common literal/number-expression
   case.
2. **Truncate from f64** — compile the argument with `{ kind: "f64" }` and keep
   the `i32.trunc_sat_f64_s`. Equivalent result; matches the apparent original
   intent of "the expression might produce f64."

Either makes the stack types line up. Prefer (1) unless there is a reason the
argument must round-trip through f64.

## Acceptance criteria

- `WebAssembly.validate()` returns `true` for `process.exit(0)`,
  `process.exit(1)`, `process.exit(42)` under `--target wasi`.
- The module still imports `wasi_snapshot_preview1.proc_exit` and calls it
  with the correct code.
- A binary-validity assertion guards the WASI `process.exit` path (so a WAT-only
  test can't mask a regression again).

## Test sentinel already in place

`tests/real-world-wasi.test.ts` carried an `it.fails(...)` sentinel asserting
`WebAssembly.validate(...) === true` for `process.exit(0)`. It passed while the
bug stood and flipped to a hard failure once codegen was fixed — at which point
the `.fails` modifier was removed.

## Resolution (2026-06-04)

Applied fix option (1): the WASI `process.exit` special case in
`src/codegen/expressions/calls.ts` already compiles the argument with expected
type `{ kind: "i32" }` (so a numeric literal lowers to `i32.const N` and any
f64-valued expression is truncated by `coerceType`), then redundantly pushed
`i32.trunc_sat_f64_s` (which expects an **f64**) on top of the i32 already on
the stack — failing `WebAssembly.validate()`. Removed the truncation push; the
expected-type compile already delivers the i32 `proc_exit` needs.

The `it.fails` sentinel was promoted to a real regression guard that asserts
`WebAssembly.validate()` for `process.exit(0/1/42)` plus a non-literal numeric
argument, and that `wasi_snapshot_preview1.proc_exit` is still imported.

**Verified**: `process.exit(0)`, `(1)`, `(42)`, and `process.exit(c)` (number
variable) all produce `success: true` + `WebAssembly.validate() === true` and
keep the `proc_exit` import. `tests/real-world-wasi.test.ts` green (7 tests).

### Separate pre-existing bug noticed (not in scope)

`tests/real-world-wasi.test.ts`'s `"reads process.argv as a valid WASI module"`
was already failing on `main` (independent of this fix): `process.argv.length`
under `--target wasi` reports `success` but emits an invalid binary —
instantiation fails in `__str_flatten` with `call[1] expected type (ref null 5),
found i32.const of type i32` (a native-string codegen type mismatch). Converted
that one assertion to a documented `it.fails` sentinel so the suite is green;
the native-string argv defect should get its own issue.
