---
id: 2625
title: "Rename js2wasm:node-io shim to js2wasm:node-process + unify --link-node-shims flag"
status: done
sprint: 65
created: 2026-06-22
updated: 2026-06-22
completed: 2026-06-22
priority: medium
feasibility: medium
task_type: refactor
area: codegen
language_feature: node-host-apis
goal: standalone-mode
related: [2603, 2524, 2512, 389, 2624]
---
# #2625 — Rename `js2wasm:node-io` → `js2wasm:node-process` + unify `--link-node-shims`

This is the RUNTIME layer of the per-module Node-emulation design
(stakeholder-confirmed, loopdive/js2#389). PR2 of the two-PR Node-API-emulation
effort.

## Problem

#2524 Phase 1 introduced a single generic linkable shim named `js2wasm:node-io`,
gated behind a `--node-io-shim` flag. Two issues:

1. **`node-io` is generic.** The per-module design (loopdive/js2#389) makes Node
   host APIs **one linkable shim PER MODULE**, named after the module: the
   `node:process` IO surface becomes `js2wasm:node-process`, with siblings like
   `js2wasm:node-fs` / `js2wasm:node-path` to follow. A single `node-io`
   namespace can't express that.
2. **The flag conflated two orthogonal axes.** `--node-io-shim` mixed "which
   modules are emulated" (now the job of auto-detect / `--emulate`) with
   "inline-vs-linked" (the only thing a flag should choose).

## Design

- **Rename the shim module string** `js2wasm:node-io` → `js2wasm:node-process`
  everywhere it appears as an import-module literal (the four `addImport` calls
  for memory + stdout_write/stderr_write/stdin_read in `src/codegen/index.ts`),
  plus the strict-mode dual-mode allowlist entry in
  `src/codegen/host-import-allowlist.ts` (`ALWAYS_ALLOWED_IMPORT_MODULES`) — the
  allowlist gate is what drops the import under WASI strict mode if the name
  drifts, so it MUST track the rename.
- **Replace `--node-io-shim` with one global `--link-node-shims`**
  (`CompileOptions.linkNodeShims`, default **false**):
  - **false** = the current inline `fd_read`/`fd_write` path (self-contained,
    the #389 default). This path is BYTE-IDENTICAL to before.
  - **true** = emit the per-module `js2wasm:node-<mod>` imports and expect the
    shim linked.
  - `CompileOptions.nodeIoShim` and the `--node-io-shim` CLI arg are removed.
    The internal codegen gate field `ctx.nodeIoShim` is renamed to
    `ctx.linkNodeShims`; the internal idx fields (`nodeIoStdoutWriteIdx`, etc.)
    are kept (cosmetic).
- **Which per-module shim is emitted is chosen by which modules are emulated,
  not by this flag** — the flag only chooses inline vs linked.
- Example artifacts renamed: `node-shim.wat` → `node-process.wat`,
  `NODE-IO-SHIM.md` → `NODE-PROCESS-SHIM.md`, generator
  `scripts/build-node-io-shim.mjs` → `scripts/build-node-process-shim.mjs`
  (export `buildNodeIoShim` → `buildNodeProcessShim`), and the
  `tests/issue-2524-node-io-shim.test.ts` → `…-node-process-shim.test.ts`.

## Verification

1. `npx tsc --noEmit -p tsconfig.json` → exit 0. ✓
2. **Byte-identity of the inline default (`--link-node-shims` OFF):**
   `nm_js2wasm.ts --target wasi` → `md5sum` == **428a96eb38121be46a7983bdff883e70**.
   This is the hard guarantee that the inline path is untouched. ✓
3. **Shim path (`--link-node-shims` ON):** the emitted `.wat` contains
   `js2wasm:node-process` (4 imports) and NO `js2wasm:node-io`. ✓
4. `npx vitest run tests/issue-2524-node-process-shim.test.ts` → 5/5 pass. ✓
5. `! grep -rn 'node-io-shim\|nodeIoShim' src/` → the flag name is gone (the
   internal `nodeIoStdoutWriteIdx`-style idx fields are intentionally kept). ✓

References loopdive/js2#389, #2603 / #2524 / #2512 / #2624.
