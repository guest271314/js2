---
id: 2655
title: Direct WASI Preview-1 fd_read/fd_write for node:fs readSync/writeSync (no shim)
status: done
completed: 2026-06-25
assignee: ttraenkler/sendev-wasi
area: host-interop
language_feature: node-api-compat
goal: platform
related: [389, 2631, 2633, 2632, 2639]
feasibility: medium
sprint: Backlog
---

# Direct WASI P1 fd_read/fd_write for node:fs readSync/writeSync (no shim)

## Problem

A stdio program that uses `node:fs` fd-based `readSync(0, …)` / `writeSync(1, …)`
currently can only reach WASI by way of the imported `node:fs` shim
(`--link-node-shims`). `src/codegen/node-fs-api.ts` `tryCompileNodeFsCall` has a
blanket `if (!ctx.linkNodeShims) return undefined;` so fd-based readSync/writeSync
ONLY lower via the shim. There is no direct
`wasi_snapshot_preview1.fd_read`/`fd_write` lowering.

This blocks the loopdive/js2 **#389** reporter's use case: a Native Messaging host
that runs directly under a WASI host (wasmtime), explicitly "not chasing Node.js".
They want a **self-contained WASI P1 command module** that imports ONLY
`wasi_snapshot_preview1` — no node:fs shim, no Node runtime.

Note: the WRITE side already has precedent — `process.stdout/stderr.write` lowers
directly to `fd_write` when shims are off (the `ensureWasiWrite*Helper` family
routes through `emitWasiWriteTail`, which branches on `ctx.linkNodeShims`). The
READ side is the genuinely new work.

## Approach

Generalize `emitNodeFsReadSync`/`emitNodeFsWriteSync` to take the target funcidx +
a "direct vs shim" mode. In `tryCompileNodeFsCall`, under `ctx.wasi`, lower
fd-based readSync/writeSync via EITHER:
- the shim (`ctx.linkNodeShims`: existing `nodeFsReadSyncIdx`/`nodeFsWriteSyncIdx`,
  signature `(fd,ptr,len) -> i32`), OR
- the direct WASI path (`!ctx.linkNodeShims`: `ctx.wasiFdReadIdx`/`ctx.wasiFdWriteIdx`,
  the 4-arg `(fd, iovs, iovs_len, out) -> errno` syscalls).

**readSync direct path** — blocking, NO reactor/poll_oneoff (the native-messaging
host uses synchronous readSync, not the async stdin reactor): set up an iovec
`{ base = bufPtr+offset, len = length }` + an `nread` out-slot in a fixed page-0
linear-memory scratch (`WASI_READSYNC_IOV_OFFSET` / `WASI_READSYNC_NREAD_OFFSET`,
chosen above the reactor's 160–336 region and below the 1024 string-data base so it
collides with neither the write scratch nor the reactor). For a linear-backed
Uint8Array the iovec base points straight at `ptr+offset` (zero-copy). For a GC
Uint8Array read into the page-1 `WASI_STDIN_BUF_START` scratch then copy out
(reusing `emitScratchToArrayCopy`). Call `fd_read(fd, iov, 1, nread)`, load nread,
return as f64 (matching the shim path's `(fd,ptr,len) -> bytesRead` contract).

**writeSync direct path** — route the buffer/string/DataView arms through the
existing `ensureWasiWrite*Helper` + `ctx.wasiFdWriteIdx` machinery (the same
`process.std*.write` uses), instead of the shim funcidx. Because `emitWasiWriteTail`
already branches on `ctx.linkNodeShims`, the GC/linear/string/DataView helpers
already emit `fd_write` directly when shims are off — so the writeSync direct path
mostly needs the funcidx selection (`wasiFdWriteIdx` vs `nodeFsWriteSyncIdx`) and to
keep its `(fd,ptr,len)` calls in the linear/zero-copy arm correct.

**Import wiring** — `needsFdRead` is currently only set by the hallucinated
`process.stdin.read(...)` shape or the stdin reactor; it is NOT set by a direct
`import { readSync } from "node:fs"`. Add: when `usesReadSync && !ctx.linkNodeShims`
under `--target wasi`, register `fd_read`. (`fd_write` is already registered for any
stream write.)

**Memory ownership** — a standalone `--target wasi` command module already owns +
exports its `memory` (non-shim branch: `ctx.mod.memories.push({min:3})` +
`exports.push({name:"memory"})`). The direct iovec/nread scratch lives in page 0 and
the read data in page 1 (`WASI_STDIN_BUF_START`), both within the reserved 3 pages,
so a pure synchronous readSync/writeSync program (no reactor) lays out + exports
memory correctly with no extra plumbing.

**Keep `--link-node-shims`** — unchanged; that path is the "same file also runs
unmodified under real node via node:fs" story. The direct path is the additional
pure-WASI-P1 mode.

## Acceptance

- A readSync/writeSync framed echo (and the native-messaging host) compiles under
  `--target wasi` with NO `--link-node-shims`; the emitted module imports ONLY
  `wasi_snapshot_preview1` (no `node:fs` import in the wasm), exports its own
  `memory`, and runs correctly under wasmtime — reads a 4-byte LE length prefix +
  body from fd 0, writes a framed response to fd 1, byte-correct. Gated on
  `findWasmtime()`.
- The `--link-node-shims` path is unchanged (node:fs shim imports, runs under node).
- Validated in batch + `runTest262File` (node-fs-api.ts is shared codegen — must be
  byte-neutral for non-node:fs programs). tsc + lint + prettier clean.

## Implementation notes (WHY)

- The direct readSync iovec scratch deliberately uses dedicated page-0 offsets
  (`WASI_READSYNC_IOV_OFFSET`/`_NREAD_OFFSET`) rather than the async reactor's
  `RL_FDREAD_IOV_OFFSET` (324) — a program could in principle use BOTH synchronous
  readSync AND the async reactor, so the two iovec scratches must not alias.
- readSync direct is a PLAIN BLOCKING `fd_read` — NOT the reactor's non-blocking
  `fd_read` + `poll_oneoff`. The synchronous `readSync` contract is "block until at
  least one byte or EOF", which is exactly wasmtime's default (blocking) fd 0
  behavior. We deliberately do NOT set `FDFLAG_NONBLOCK`, so this path pulls in only
  `fd_read` — no `fd_fdstat_set_flags`, no `poll_oneoff`, no timer heap.
- A read error (errno != 0) yields 0 bytes (the read loops in user code treat
  `r <= 0` as EOF/stop), matching the shim's behavior and the Node contract closely
  enough for the streaming use case.

## Test Results

`tests/issue-2655-direct-wasi-readsync-writesync.test.ts` — 6/6 pass:
- direct compile imports ONLY `wasi_snapshot_preview1` fd_read/fd_write, no
  `node:fs`, exports its own `memory`, no reactor machinery; module validates.
- `--link-node-shims` still emits the node:fs shim imports (dual mode preserved).
- wasmtime-gated: framed echo byte-for-byte incl. high/null bytes (0x00/0xff/0x80);
  readSync `length` cap; string + DataView writeSync overloads — all byte-correct.

Shim path (#2631/#2633/#2639) + broader WASI suites unchanged. A sample of
unrelated test262 files still `pass` (node-fs-api.ts is shared codegen, byte-neutral
for non-node:fs programs). tsc + biome + prettier clean. Pre-existing unrelated
failure: `issue-1655` subarray "illegal cast" reproduces on clean main (not this PR).

PR: loopdive/js2#2037.
