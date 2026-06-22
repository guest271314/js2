---
id: 2589
title: "Auto-resolve ambient `process` typing under --target wasi (kill TS2580 'Cannot find name process' warnings)"
status: done
sprint: Backlog
created: 2026-06-22
updated: 2026-06-22
completed: 2026-06-22
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: feature
area: checker
language_feature: node-host-apis
goal: standalone-mode
related: [2523, 2524, 1717, 389]
---

## Problem

Compiling a host that uses `process` with `--target wasi` emits a repeated TS
warning, once per use:

```
warning: Cannot find name 'process'. Do you need to install type definitions for node? Try `npm i --save-dev @types/node`.
```

This is the TS2580 diagnostic (downgraded to a warning in #1717) — `process`
has no ambient declaration because we serve only the bundled TS lib files, not
`@types/node`. But the compiler **already lowers** `process.stdin/stdout/stderr`,
`process.argv`, `process.env`, `process.exit` for the WASI target
(`node-process-api.ts`) — i.e. it genuinely emulates Node on this path. So the
global is supported; only its *type* is missing, which produces noise on every
use. Surfaced by an external user in loopdive/js2#389 (bundled Native Messaging
host).

## Fix

When the WASI / node-emulation path is active, serve a synthetic ambient
`process` `.d.ts` (a global script — no import/export) to the type-checker so it
resolves `process` and never emits TS2580 for it. Declares exactly the surface
the lowering supports (`std{in,out,err}`, `argv`, `env`, `platform`, `exit`) —
not more, so unsupported members still surface.

- `src/checker/index.ts` — `AnalyzeOptions.wasi`; `analyzeSource` adds the
  synthetic root `__js2wasm_node_env.d.ts` when `wasi`. **Dup-safe**: if the
  user already declares `process` themselves, the build detects the
  duplicate-identifier diagnostic and rebuilds without injection, so we never
  turn a benign warning into a hard error.
- `src/compiler.ts` / `src/compiler/output.ts` — thread `wasi: options.target === "wasi"`.

**Type-level only** — emitted wasm is byte-identical (verified by md5: the
example host compiles to the same `nm_js2wasm.wasm` with and without the change).
Codegen lowers `process.*` syntactically regardless of this declaration.

## Verification

- Example host `examples/native-messaging/nm_js2wasm.ts --target wasi`: 5 → **0**
  `process` warnings; wasm md5 unchanged.
- `tests/issue-2589-process-ambient-typing.test.ts` (4 tests): resolves under
  wasi; still warns without wasi; genuinely-undefined names still warn (no
  blanket suppression); user-declared `process` does not dup-error.

## Notes

Pairs with #2523 (web vs node target) and #2524 (node-io shim). The gate chosen
is **wasi-implies-node-emulation** (lower friction than a separate
`--emulate-node` flag, since `--target wasi` already lowers `process.*`); a
distinct flag remains a possible future refinement. The incremental
`IncrementalLanguageService` path (used by the playground/tests, not the CLI)
does not yet inject — follow-up if its warnings matter.
