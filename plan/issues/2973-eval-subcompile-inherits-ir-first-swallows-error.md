---
id: 2973
title: "eval-shim sub-compiles inherit JS2WASM_IR_FIRST and swallow its hard errors — silent `undefined` instead of fail-loud"
status: done
assignee: ttraenkler/dev-2973
completed: 2026-07-02
sprint: 69
created: 2026-07-02
updated: 2026-07-03
priority: high
feasibility: easy
horizon: s
task_type: bug
area: compiler
language_feature: eval
goal: correctness
related: [2138, 2924]
origin: "2026-07-02 #2138 Slice-3 full flagged test262 run (28580162377) — divergence class 2 (the ONLY silent wrong answer found)"
---

# The one silent divergence under IR-first: eval sub-compiles

## Problem

`test/language/statements/expression/S12.4_A2_T2.js` was the single
`pass → fail` (runtime wrong-answer) regression in #2138's full flagged run
— and the ONLY divergence that violated the fail-loud contract:

- `src/runtime-eval.ts:213` compiles eval strings as
  `compileSourceSync("export function __eval_result() { return (<src>); }")`
  — an **in-process sub-compile that inherits `process.env.JS2WASM_IR_FIRST`**.
- The synthesized wrapper is a claimable top-level FunctionDeclaration; under
  the flag its legacy body is skipped. The eval'd expression
  (`5+1|0===0` — mixed f64/i32 `|` operands) hits a claim-partial type
  residual, so the IR build fails post-claim → hard compile error (correct,
  fail-loud) — **but the shim's `catch` arms (runtime-eval.ts:218/:231)
  swallow the failure** and fall through, yielding `undefined` instead of `7`.

Net effect: the #2138 hard-error contract is converted into a **silent wrong
answer** for any eval'd code containing a claim-partial residual. This is a
flag-on-only bug today (default builds unaffected), but it is the exact
silent-wrong-code class the inversion exists to eliminate — it must not
survive into any future default-on rollout.

## Fix

Exclude eval/`new Function` sub-compiles from the IR-first investigation:
in `runtime-eval.ts` (and any sibling in-process sub-compile sites, e.g. the
#2924 `new Function` compile-away), pass an explicit opt-out through
`compileSourceSync` options (preferred: a `codegenOptions` flag threaded to
`generateModule` that overrides the env read; acceptable first cut:
save/clear/restore `process.env.JS2WASM_IR_FIRST` around the sub-compile).
Sub-compiles are a semantics-critical fast path, not a measurement target —
they should always take the proven legacy-then-overlay pipeline.

Alternative (rejected): making the shim rethrow flag-on compile errors —
that fixes the SILENCE but turns recoverable eval fast-path misses into user-
visible failures; the shim's contract is graceful fallback.

## Acceptance criteria

- `JS2WASM_IR_FIRST=1` run of S12.4_A2_T2 passes (eval returns 7).
- A regression test pinning: flag-on eval of a claim-partial-residual
  expression equals its flag-off result.
- Sub-compile opt-out is structural (options-based), not ambient env
  mutation, OR documented why env save/restore is safe (single-threaded
  compile path).

## Resolution (2026-07-02)

Structural options-based opt-out, not ambient env mutation:

- Added `disableIrFirst?: boolean` to `CompileOptions` (`src/index.ts`) and the
  backend `CodegenOptions` (`src/codegen/context/types.ts`), threaded through
  `buildCodegenOptions` (`src/compiler.ts`).
- `generateModule` (`src/codegen/index.ts`) now computes
  `irFirst = experimentalIR && !disableIrFirst && truthyEnv(JS2WASM_IR_FIRST)`
  — the opt-out disables ONLY the fail-loud skip-body inversion; the ordinary
  IR overlay (`experimentalIR`) is untouched.
- Both `compileSourceSync` sub-compiles in `runtime-eval.ts` (expression-form
  and statement-form wrappers) pass `disableIrFirst: true`. These are the only
  in-process sub-compile sites in the tree today (the env.ts `new Function` is
  host-side introspection, not a compiler sub-compile; #2924's compile-away is
  not yet a sub-compile site — the `CompileOptions` doc notes it for forward
  compat).

Byte-inert for default builds: `disableIrFirst` only short-circuits a boolean
already gated on `truthyEnv(JS2WASM_IR_FIRST)`, which default/CI compiles never
set — so no test262 baseline movement.

## Test Results

`tests/issue-2973.test.ts` — 4/4 pass:

- flag-off `eval("5+1|0===0")` = 7 (control)
- flag-ON `eval("5+1|0===0")` = 7 (was `undefined` before the fix)
- flag-on result === flag-off result
- unit: same wrapper compiles `success=false` under flag-on without the opt-out,
  `success=true` with `disableIrFirst: true`

Measured on origin/main @ 1062b8b38.
