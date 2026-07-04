---
id: 2815
title: "Suppress spurious 'Cannot find name Deno' (TS2304) warning on the recognized Deno stdio surface"
status: done
sprint: 69
priority: low
area: checker
related: [389, 2684, 1951, 2603]
completed: 2026-06-29
assignee: ttraenkler/agent-a9c3d48
---

# Suppress spurious `Cannot find name 'Deno'` (TS2304)

> Note: this issue was originally requested as id `2811`, but `2811` was already
> taken on `main` (`2811-dstr-captured-builtin-name-and-dstr-param-closure-offset`).
> Re-allocated to `2815` via `claim-issue.mjs --allocate` to satisfy the
> `check:issue-ids:against-main` dup-id gate.

## Problem

js2wasm natively recognizes the `Deno.stdin/stdout.{readSync,writeSync}` surface
(`src/codegen/deno-api.ts`) and lowers it to WASI fd IO. But the checker still
emits `warning: Cannot find name 'Deno'. (2×)` when compiling a Deno host — the
loopdive/js2#389 reporter flagged it ("What's up with that warning?"). It's noise,
the same class as the `Cannot find name 'process'` (TS2580) already downgraded
(#1951/#2603).

Root cause: the **single-source** checker path (`analyzeSource`) injects an
ambient `Deno` `.d.ts` (`buildDenoEnvDtsForSource`, #2684), so it never warns. But
the **multi-file** paths (`analyzeMultiSource` / `analyzeFiles`) inject no such
d.ts. The moment a real Deno host imports a shared, host-agnostic core (the
reporter's exact layout — `examples/native-messaging/nm_js2wasm_deno.ts` imports
`nm_js2wasm_sync_framing.ts`), compilation routes through the multi-file analyzer
and TS2304 leaks as the `(2×)` warning. The diagnostic is downgraded to a warning
(`DOWNGRADE_DIAG_CODES` includes 2304) but is still printed.

## Fix

In `src/checker/index.ts`, drop the TS2304 `Cannot find name 'Deno'` diagnostic in
the multi-file analyze paths **only** when the flagged `Deno` identifier is the
root object of a recognized `Deno.{stdin,stdout,stderr}` property access
(`isRecognizedDenoStdioNotFound` + `filterRecognizedDenoStdioDiagnostics`). This is
scoped to the natively-lowered stdio surface — a genuinely-unknown reference (bare
`Deno`, `Deno.notAThing`, or any other unknown name) still surfaces its error. No
blanket identifier suppression; codegen is unchanged (deno-api.ts lowers the
member-call shape syntactically regardless of types).

## Verify

- `npx tsx src/cli.ts examples/native-messaging/nm_js2wasm_deno.ts --target wasi`
  no longer emits `Cannot find name 'Deno'`; it compiles to a valid pure-WASI-P1
  module that framed-echo round-trips byte-for-byte under real wasmtime v46
  (`~/.local/bin/wasmtime`).
- Scoping holds: `Deno.notAThing`, bare `Deno`, and unrelated `Foo` all still warn.
- The `process` downgrade and unrelated diagnostics are unaffected.

## Test Results

`tests/issue-2815-deno-not-found-warning.test.ts` — 5/5 pass:

- recognized `Deno.stdin`/`Deno.stdout` surface (multi-file): no TS2304 'Deno'
- Deno adapter compiles to a valid wasi module, no warning
- `Deno.notAThing` still warns
- bare `Deno` still warns
- unrelated `Foo` still warns
