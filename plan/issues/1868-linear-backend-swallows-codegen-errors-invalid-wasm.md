---
id: 1868
title: "Linear backend swallows codegen errors → emits invalid wasm with success:true (Refresh Benchmarks CI crash)"
status: done
created: 2026-06-04
updated: 2026-06-04
completed: 2026-06-04
priority: high
feasibility: easy
task_type: bugfix
area: codegen-linear
goal: correctness
sprint: 59
---
# #1868 — linear backend emits structurally invalid wasm while reporting success

## Symptom

The `benchmark-refresh.yml` workflow (job step "Refresh benchmark artifacts",
`pnpm run refresh:benchmarks`) failed on every push to `main` from ~12:14 on
2026-06-04 onward (10+ consecutive commits). The first step,
`benchmarks/run.ts`, crashed fatally on the `string/split` benchmark:

```
[parse exception: popping from empty stack (at 0:3158)] Fatal: error in parsing wasm binary
RuntimeError: memory access out of bounds
   at runStrategy (benchmarks/harness.ts:189)
```

Two distinct failure modes were tangled together:

1. **Invalid wasm with `success: true`.** Several string/array benchmarks that
   use `String.prototype.repeat` (`concat-long`, `indexOf`, `includes`,
   `replace`, `case-convert`, …) compile in the **linear-memory** backend to a
   binary that fails `WebAssembly.compile` —
   `function #43:"run": not enough arguments on the stack for local.set (need 1,
   got 0)`. Binaryen prints `[parse exception: popping from empty stack]` while
   trying to optimize it.

2. **Fatal runtime trap in the harness timed loop.** `string/split` lowers to
   *valid* wasm but its linear-memory bump allocator exhausts memory after many
   `csv.split(",")` iterations and traps with `memory access out of bounds`.
   Whether that trap lands in the harness **warmup** loop (caught, strategy
   skipped) or in the **timed** loop (`harness.ts:189`, NOT guarded) is
   non-deterministic across V8 versions — so the suite passed locally on
   Node 25 but aborted fatally on CI's Node 26.

## Root cause

`src/codegen-linear/index.ts` accumulates unsupported-construct diagnostics
into `ctx.errors` (e.g. `compileMethodCall` pushes `Unsupported method call:
.repeat()`), but it pushes **no value onto the Wasm stack** before returning.
The following `local.set` / `local.tee` / `call` then underflows the stack —
producing structurally invalid wasm.

Crucially, `compiler.ts` **never read** those linear-backend errors. The
WasmGC path returns `{ module, errors }` and bails with `success: false` on any
`Codegen error:`; the linear path returned only a bare `WasmModule` and its
`ctx.errors` were dropped on the floor. So `compile(...)` reported
`success: true` with an invalid binary — the worst failure mode (a downstream
consumer crashes instead of getting a clean compile error).

The harness's **timed** loop (`benchmarks/harness.ts`) lacked the try/catch the
**warmup** loop already had, so a mid-run runtime trap aborted the whole suite.

## Fix

- `src/ir/types.ts`: add optional `WasmModule.codegenErrors`.
- `src/codegen-linear/index.ts`: both `generateLinearModule` and
  `generateLinearMultiModule` surface `ctx.errors` via `mod.codegenErrors`.
- `src/compiler.ts`: new `collectLinearCodegenErrors(mod, errors)` helper; all
  three linear call sites now fail the compile (`success: false`) when the
  linear backend reported errors, mirroring the WasmGC path. Unsupported
  constructs now yield a clean compile error instead of invalid wasm.
- `benchmarks/harness.ts`: wrap the timed-run loop in the same try/catch as
  warmup, so a mid-loop runtime trap downgrades to a skipped strategy instead
  of aborting the entire benchmark suite.

This is a targeted compiler-correctness fix, not a benchmark edit — the
benchmark sources are valid TS; the linear backend simply doesn't lower
`repeat`/`replace`, and must say so honestly.

## Regression window

The linear backend itself did not change in the window; the symptom surfaced
because the OOB trap timing shifted between warmup (caught) and the timed loop
(fatal) on CI's Node 26. The underlying invalid-wasm/error-swallow bug is
latent — `success: true` + invalid binary predates the window. Both are fixed
here.

## Validation

- `tests/issue-1868.test.ts` — 7 tests: unsupported linear constructs now
  return `success: false` with a `Codegen error:`; no `success: true` binary
  fails `WebAssembly.compile`; supported string ops (`indexOf`, `split`) still
  compile to valid, runnable wasm.
- All 67 existing `tests/linear-*.test.ts` pass (no over-triggering).
- `pnpm run refresh:benchmarks` completes (exit 0); `benchmarks/run.ts` no
  longer aborts — unsupported linear strategies print a clean
  `[linear-memory skipped: Compilation failed]` and `split`'s mid-loop OOB
  prints `[linear-memory skipped (runtime, mid-loop): …]`.
- `tsc --noEmit` clean; prettier + biome clean.
