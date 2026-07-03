---
id: 2771
title: "Bundle relative imports for standalone WASI CLI compilation (shared local helper + node:fs IO)"
status: done
assignee: ttraenkler/sdev-2771-bundling
created: 2026-06-28
completed: 2026-06-28
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: compiler
goal: platform
related: [2756, 389, 2655]
sprint: 69
---

# #2771 — bundle relative imports for standalone WASI compilation

## Problem

Sharing a local helper file across CLI-compiled standalone WASI examples was
impossible in BOTH compile paths. A standalone program whose **entry** imports a
local `./shared.ts`, with the `node:fs` fd-IO seam (`readSync`/`writeSync` over a
`Uint8Array`) split across the two files, could not be compiled to a clean
self-contained WASI command module. This is the compiler unblock for the #2756
native-messaging dedup.

Two independent blockers (verified by dev-2756):

1. **Single-source CLI path** (`src/cli.ts`): the CLI calls `compile(source, …)`,
   which reads exactly ONE file and strips every import in `preprocessImports`.
   So `import { runEchoLoop } from "./nm_sync_framing"` was unresolved and
   `runEchoLoop` lowered to a host import `env.runEchoLoop` → the WASI
   strict-no-host-imports gate hard-rejects it (and even when dropped, the module
   had no IO).

2. **Multi-file `compileMultiSource()`** (`src/compiler.ts`): it DOES bundle
   relative imports (TS program resolves them), but **never ran**
   `detectNodeFsImports` / `detectRawWasiImports`, so `wasiNodeFsFuncs` stayed
   undefined → a `node:fs` `readSync`/`writeSync` (even in the entry) lowered to
   ZERO fd IO (`imports = []`). A `node:fs` program compiled to a module with no
   `fd_read`/`fd_write`.

## Fix — BOTH (a) and (b); neither alone suffices

- **(a) CLI routing** (`src/cli.ts` + new `entryHasRelativeImports` in
  `src/compiler.ts`): when the entry statically imports / `require`s a RELATIVE
  module (`./x` / `../x`), route to the multi-file bundler `compileProject`
  instead of single-source `compile`. Entries with no relative import (plain,
  `node:`-only, bare-package) stay on the single-source path → **byte-identical**.
- **(b) node:fs / raw-WASI detection in the bundler** (`src/compiler.ts
  compileMultiSource`): union `detectNodeFsImports` / `detectRawWasiImports`
  across EVERY bundled file (the CJS-rewritten map) and thread the resulting
  `wasiNodeFsFuncs` / `wasiRawImports` / `wasiMemAccessors` into
  `buildCodegenOptions`, so a `node:fs` fd call living in a SHARED helper lowers
  to `fd_read`/`fd_write` module-wide. The unions are empty for any program that
  imports none of these modules → existing multi-file compiles stay
  byte-identical.

(a) alone is insufficient: `compileProject` would still emit zero fd IO. (b)
alone is insufficient: the CLI never reaches `compileProject`.

## Implementation notes (WHY)

- The `preprocessImports` strip-all-imports behaviour is correct for a single
  file but cannot run in multi-mode (it would strip the cross-file relative
  imports the TS program needs). So (b) does NOT run `preprocessImports`; it only
  runs the two **string scanners** (`ts.createSourceFile` + import-decl walk),
  which mutate nothing. Codegen already drops the `node:fs` import binding and
  lowers the call sites purely on `ctx.wasiNodeFsFuncs` membership
  (`node-fs-api.ts`, `index.ts:12423`), so populating the set is enough — no
  source rewrite required.
- `nodeBuiltins` / `jsxRuntime` parity for multi-mode is intentionally left out
  of scope (a larger `preprocessImports`-parity change tracked alongside #2138);
  #2771 only needs the WASI fd surfaces.
- Routing on relative imports (not on `--target wasi`) is deliberately general:
  relative-import programs were silently broken on ALL targets, so the bundler is
  the right home for them regardless of target.

## Acceptance — verified

- Two-file standalone program (entry imports `./shared`, `node:fs` `readSync`/
  `writeSync` IO in the shared helper) compiles under `--target wasi` to module
  imports = `wasi_snapshot_preview1` ONLY (no `env.*`), and echoes a framed
  message **byte-exact** under wasmtime (fd_read/fd_write work). See
  `tests/issue-2771-relative-import-standalone-wasi.test.ts` (3 tests, incl. the
  live wasmtime echo).
- **Byte-neutral** for existing single-file programs: `nm_js2wasm.ts` (single
  file, node:fs) produced sha256 `38a7a991…` / 60478 bytes on BOTH origin/main
  and this branch; a `runTest262File` control batch (language/expressions/
  addition) was identical on both trees (10/12 pass, same 2 pre-existing fails);
  lodash-es `partial.js` multi-file compile produced byte-identical 305202-byte
  output on both trees.
- tsc + biome lint clean; prettier applied.

## Downstream consumer

After #2756 (example renames `nm_js2wasm`→`nm_node_fs`) and this issue land, a
small follow-up re-applies the `nm_deno`/`nm_node_fs` shared-core dedup on top
(dev-2756 preserved the experiment). Not part of #2771.

## Files

- `src/compiler.ts` — `entryHasRelativeImports` (exported); WASI-import detection
  in `compileMultiSource`.
- `src/index.ts` — re-export `entryHasRelativeImports`.
- `src/cli.ts` — route relative-import entries to `compileProject`.
- `tests/issue-2771-relative-import-standalone-wasi.test.ts` — focused test.
