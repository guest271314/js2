---
id: 2642
title: "Stale cached __wasi_write_string funcIdx across a late-import boundary emits invalid Wasm for console.log of a string|null/undefined concat under --target wasi"
status: done
completed: 2026-06-24
created: 2026-06-24
updated: 2026-06-24
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen
language_feature: native-strings
goal: standalone
sprint: 65
related: [2641, 2632, 1461, 2193]
origin: "Architect-root-caused (arch-2642) on clean main; distinct from #2641. Originally reported via a closure/class/process.stdin program, but those features are ALL incidental — the minimal repro is a plain free function returning string|null concatenated in console.log."
---
# #2642 — stale `__wasi_write_string` funcIdx across a late-import boundary → invalid Wasm

## Problem

A WASI `console.log` whose argument inline-concatenates a `string | null` /
`string | undefined` value (an externref union) emits **invalid Wasm** under
`--target wasi`:

```
call expected (ref null N), found i32.const   (function "main")
```

### Minimal repro (closure / class / process.stdin are ALL incidental)

```ts
function rd(): string | null { return "x"; }
export function main(): void { const x = rd(); if (x !== null) { console.log("r:" + x); } }
```

Compiled `{ target: "wasi" }` → `WebAssembly.compile` rejects it. The
`string | undefined` variant and the multi-arg / two-call variants fail the same
way. A plain-string `console.log("hello")` (no union concat) is valid — so the
trigger is specifically *insert-a-late-import while compiling a console.log
argument, then write again with a cached helper index*.

## Root cause

`compileConsoleCallWasi` (`src/codegen/expressions/builtins.ts`) read
`__wasi_write_string`'s function index **once** at the top
(`const writeStringIdx = ctx.funcMap.get(helperName)`) and reused it for the
separator, template-part and trailing-newline writes. The sibling
`emitWasiValueToStdout` did the same for its `[object]`-placeholder fallbacks.

Compiling an inline-concat argument whose value is a `string | null` /
`string | undefined` externref union inserts the `__extern_toString` late import
via `ensureLateImport` + `flushLateImportShifts` (`src/codegen/binary-ops.ts`),
which shifts **every** function index by +1. The trailing newline / separator
writes then emitted the **stale** index → post-shift it resolves to a *different*
function (`__regex_escape`, whose signature takes a `(ref null N)`), so the
`call` sees the `i32.const` offset/length operands meant for
`__wasi_write_string` against `__regex_escape`'s ref parameter →
`call expected (ref null N), found i32.const` → invalid module.

This is the same family as `reference_1461_reduce_noinit_funcidx_desync` and
`reference_2193_call_ref_funcref_not_wrapper`: a funcIdx captured before a
late-import insertion is stale afterward.

## Fix

Re-resolve the helper index **by NAME** from `ctx.funcMap` at every emission
site that writes *after* a `compileExpression` / `ensure*Helper` call — the
separator, template-part and trailing-newline writes in
`compileConsoleCallWasi`, and the placeholder writes in
`emitWasiValueToStdout`. Both functions now use a local `writeStr(offset,
length)` helper that re-reads `ctx.funcMap.get(helperName)` on each call instead
of closing over a cached index. No funcIdx is held across the union-concat
argument's compilation.

### Invariant (enforced + commented in both functions)

> A funcIdx read once must NEVER be reused across an `ensureLateImport` /
> late-import insertion. Re-read it from `ctx.funcMap` (by name) after any call
> that can add an import.

## Validation

`tests/issue-2642.test.ts` — five validity guards (string|null, string|undefined,
union-concat as first of multiple args, union-concat + a second console.log,
and the `console.warn` stderr-helper variant) that each fail `WebAssembly.compile`
pre-fix and pass post-fix, plus two negative-control runtime checks
(plain-string single- and multi-arg console.log) asserting byte-exact stdout.

Per #1968 (shared-state index-shift family) an isolated byte-diff would be a
FALSE NEGATIVE, so the guard is "the module validates"; full `merge_group` /
test262 re-validation in CI confirms broad byte-neutrality for programs that do
not hit the union-concat-then-write pattern. tsc + biome lint clean. The 4
pre-existing `process.argv` / `process.env` WASI failures are unrelated and
identical on origin/main.
