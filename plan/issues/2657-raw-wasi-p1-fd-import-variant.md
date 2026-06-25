---
id: 2657
title: "Raw wasi_snapshot_preview1 fd_read/fd_write import + nm_wasi.ts variant"
status: done
completed: 2026-06-25
assignee: ttraenkler/sendev-rawwasi
area: host-interop
language_feature: wasi
goal: platform
related: [389, 2655, 2631]
feasibility: medium
sprint: Backlog
---

## Problem

loopdive/js2#389's reporter wants the _most honest pure-WASI-P1_ expression of a
native-messaging host: **no `node:fs` surface at all**, importing `fd_read` /
`fd_write` DIRECTLY from `wasi_snapshot_preview1` — the real WASI Preview-1 core
module a runtime like wasmtime satisfies. The existing `nm_js2wasm.ts` variant
(#2631/#2655) uses `node:fs` `readSync`/`writeSync`, which is faithful but still
Node-shaped; this issue adds the raw-syscall variant alongside it.

### Root cause (why it doesn't work on main today)

`import { fd_write } from "wasi_snapshot_preview1"` is stripped by
`preprocessImports` and replaced with `declare function fd_write(...): any`. Under
`--target wasi` the resulting bare call binds to nothing (no host target, strict
mode), and the call is silently dead-code-eliminated — no `fd_write` import is
emitted. So the raw-WASI import path is simply unimplemented.

## Design

Mirror the existing `wasiNodeFsFuncs` mechanism (#2631) but as a **raw
passthrough** — the user already supplies the four i32 linear-memory offsets, so
codegen just binds the identifier to the WASI import func and emits a direct
`call`. No buffer/scratch management (that's the `node:fs` shim's job).

1. **`compiler.ts`** — `detectRawWasiImports(source)` (pre-preprocessing, like
   `detectNodeFsImports`) collects the local names imported from
   `"wasi_snapshot_preview1"` (→ `wasiRawImports`) AND from the intrinsic module
   `"wasm:memory"` (→ `wasiMemAccessors`). Both threaded through
   `buildCodegenOptions` → `CodegenContext` (single-source only, same constraint
   as `wasiNodeFsFuncs`; multi-source stays `undefined`). The preprocessor strips
   both imports to bare `declare function` stubs, so no ambient `.d.ts` injection
   was needed — the call sites resolve to typed-`any` stubs and codegen compiles
   the args under an i32 hint.
2. **`index.ts` `registerWasiImports`** — when `ctx.wasiRawImports` has
   `fd_read`/`fd_write`, force `needsFdRead`/`needsFdWrite` so the **existing**
   #2037 `addImport` → `ctx.wasiFdReadIdx`/`wasiFdWriteIdx` registration fires.
   No duplicate imports — the user binding routes to the same import func index.
3. **`raw-wasi-api.ts`** (new) — `tryCompileRawWasiCall`: an unshadowed
   `fd_read`/`fd_write` bound from `wasi_snapshot_preview1` → a direct `call` of
   the WASI import (4 i32 args, returns i32 errno); an unshadowed
   `store32`/`load32`/`store8`/`load8` bound from `wasm:memory` → a single inline
   memory op. Wired into `calls.ts` just before `tryCompileNodeFsCall`.

See **Implementation notes (final)** below for the honest two-surface naming
decision and why no allowlist/leak-scan change was needed.

## Implementation notes (final)

### Two honestly-separated source surfaces (naming decision)

`fd_read`/`fd_write` ARE real `wasi_snapshot_preview1` Preview-1 functions, so
they're imported from `"wasi_snapshot_preview1"` and bound 1:1 to the WASI import
func. The example also needs to lay out the iovec `{buf, buf_len}` + result slot
in linear memory, which required a raw linear-memory store/load surface js2wasm
didn't expose (DataView/ArrayBuffer are GC-backed, not linear). Those accessors
(`store32`/`load32`/`store8`/`load8`) are NOT WASI host functions — no host
provides a `wasi_snapshot_preview1.store32` — so surfacing them under the WASI
module name would mislabel compiler intrinsics as host syscalls (the
`feedback_node_apis_via_per_module_shim_not_builtin` anti-pattern). They are
imported from a distinct js2wasm INTRINSIC namespace, **`"wasm:memory"`** (mirrors
`wasm:js-string`), and lower to a single inline WASM memory op — NO import is
emitted. So the emitted module's ONLY import module is `wasi_snapshot_preview1`.
The module-name constant is `WASM_MEMORY_INTRINSIC_MODULE` in `src/compiler.ts`.

### Memory access lowering

| source (`wasm:memory`) | inline op     |
| ---------------------- | ------------- |
| `store32(addr, v)`     | `i32.store`   |
| `load32(addr)`         | `i32.load`    |
| `store8(addr, v)`      | `i32.store8`  |
| `load8(addr)`          | `i32.load8_u` |

All gated on `ctx.wasiMemAccessors` (the fd path on `ctx.wasiRawImports`), so the
whole feature is byte-neutral for any program importing neither module.

### Why no allowlist / leak-scan change

`wasi_snapshot_preview1` is already in `ALWAYS_ALLOWED_IMPORT_MODULES`, and the
`wasm:memory` accessors emit no import at all, so neither the strict-mode
allowlist nor the post-link leak scan needed touching.

## Test Results

`tests/issue-2657-raw-wasi-fd-import.test.ts` — all green incl. a REAL wasmtime
byte-correct framed echo (high/null bytes) and a 150 KiB multi-window body.
Imports asserted to be ONLY `{wasi_snapshot_preview1}`; accessors verified inline
(not imports). `nm_js2wasm.ts` (node:fs variant) confirmed still compiling.
