---
id: 2833
title: Extension-less relative imports break Deno / `deno bundle` in native-messaging examples
status: done
sprint: 69
priority: medium
area: examples
task_type: bug
related: [389]
assignee: ttraenkler/agent-a5eb860ae7564464e
completed: 2026-06-29
---

# Extension-less relative imports break Deno in native-messaging examples

## Problem

`examples/native-messaging/nm_js2wasm_deno.ts` and
`examples/native-messaging/nm_js2wasm_node_fs.ts` both imported the shared
framing core with **no file extension**:

```ts
import { runNmHost } from "./nm_js2wasm_sync_framing";
```

Deno's module resolver (used by `deno run`, `deno check`, and `deno bundle`)
cannot resolve an extension-less relative import without
`--unstable-sloppy-imports` plus an import-map alias. The loopdive/js2#389
reporter hit exactly this:

```
error: Cannot find module 'file:///…/nm_js2wasm_sync_framing'.
       Maybe add a '.ts' extension or run with --sloppy-imports
```

The `nm_js2wasm_deno.ts` doc comment explicitly promises the file runs
UNMODIFIED under real `deno run`, so the missing extension was a direct
contradiction of the example's stated contract.

## Fix

Add the explicit `.ts` extension to the relative imports:

```ts
import { runNmHost } from "./nm_js2wasm_sync_framing.ts";
```

Applied to both `nm_js2wasm_deno.ts:53` and `nm_js2wasm_node_fs.ts:66`. A grep
of ALL of `examples/` for other extension-less relative imports
(`from "./…"` / `from "../…"` and dynamic `import("./…")`) found no others —
these two were the only occurrences. The `.ts`-extension import form is
TypeScript's NodeNext / `allowImportingTsExtensions` style and resolves cleanly
across every consumer here (Deno, bun, and the js2wasm CLI), so no tsconfig
change was needed.

## Test Results

Toolchain available: deno 2.8.3, bun 1.3.14, node v25.9.0, wasmtime 46.0.1.

- **`deno check` (strict resolver — the failing path):**
  - Control (extension-less, on a temp copy) → FAILS with the reporter's exact
    error: `Cannot find module '…nm_js2wasm_sync_framing'. Maybe add a '.ts'
    extension or run with --sloppy-imports`.
  - Fixed (`.ts`) → `deno check nm_js2wasm_node_fs.ts` and
    `deno check nm_js2wasm_deno.ts` both PASS.
- **`deno bundle … -o /tmp/x.js` WITHOUT `--sloppy-imports`** → succeeds for
  both `nm_js2wasm_node_fs.ts` and `nm_js2wasm_deno.ts` (2 modules bundled
  each). (Note: deno 2.8's esbuild-based `deno bundle` is itself lenient about
  the extension; `deno check`/`deno run` are the strict path the reporter hit,
  and those are now fixed.)
- **`node examples/native-messaging/scale-test.mjs`** with
  `NM_SCALE_SIZES_MIB="1 64"` → PASS: all four variants
  (`node_process`, `deno`, `wasi_p1`, `node_fs`) build via `bun build` and
  round-trip the 1 MiB and 64 MiB framed bodies under real wasmtime, re-chunking
  to valid ≤1 MiB JSON frames.
- **js2wasm CLI `--target wasi`** on both changed files → compiles cleanly to
  `.wasm` (no import-resolution regression).
