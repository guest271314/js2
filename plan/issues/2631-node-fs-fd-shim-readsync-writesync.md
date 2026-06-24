---
id: 2631
title: "node:fs fd-based readSync/writeSync via a per-module shim (Native Messaging example)"
status: done
sprint: 65
assignee: ttraenkler/agent-a0c9d00fc32018cde
completed: 2026-06-23
feasibility: medium
depends_on: [2524, 2625]
---

# node:fs fd-based readSync/writeSync via a per-module `node:fs` shim

## Problem (loopdive/js2#389)

The Native Messaging host example `examples/native-messaging/nm_js2wasm.ts` used
the js2wasm-specific `process.stdin.read(buffer, offset)` /
`process.stdout.write` / `process.stderr.write` shapes. The reporter
(guest271314) correctly noted that **`process.stdin.read(buffer, offset)` matches
NO real Node API**: Node's `process.stdin` is an async Duplex stream with no
synchronous buffer-filling `read`. The faithful synchronous Node primitives are
`fs.readSync(fd, …)` / `fs.writeSync(fd, …)` (fd-based, integer fd 0/1/2 — NOT
path-based; this is also what Javy uses: `Javy.IO.readSync`). Because the source
used a non-Node shape, it could not run unmodified under real `node`, and the
reporter's hand-port of the stderr telemetry path didn't work.

## Acceptance criteria

- [x] The example imports `{ readSync, writeSync } from "node:fs"` and drops the
      `process` global entirely; the SAME source compiles to standalone WASI via
      js2wasm AND runs UNMODIFIED under real `node`.
- [x] `node:fs` is a **per-module shim** (`node-fs.wat`), mirroring
      `js2wasm:node-process` (#2524/#2625) — codegen only wires
      `import { readSync, writeSync } from "node:fs"` → calls to imported
      `node:fs` shim functions; the syscall sequence lives in the `.wat` shim, NOT
      in codegen.
- [x] The wasm import MODULE name is `node:fs` (the declared interface), member
      names are the real Node members `readSync`/`writeSync` — the shim
      implementation name never leaks into the module's declared dependency.
- [x] `readSync(0,…)`/`writeSync(1,…)`/`writeSync(2,…)` are recognized ONLY with an
      fd argument; they map 1:1 to WASI `fd_read`/`fd_write` (no path_open, no
      preopens, NO filesystem). Path-based `readFileSync(path)` is rejected under
      `--target wasi`.
- [x] Over-read safety preserved: `length` is passed as the remaining-to-target
      count, so a read can never pull bytes past the current message.
- [x] stderr telemetry (`writeSync(2, …)`) works.
- [x] `main()` is invoked (top-level `main();` → compiled `_start`; importable
      under node).
- [x] Tests assert the emitted `node:fs` imports (and no direct
      `wasi_snapshot_preview1` fd_read/fd_write for that path), a byte-for-byte
      round-trip linking `node-fs.wasm`, fd=2 routing, over-read safety, and the
      path-based rejection. The `wasmtime` smoke test passes under a real runtime.

## Implementation summary

- **`examples/native-messaging/node-fs.wat`** — new linkable shim exporting
  `readSync(fd,ptr,len)->i32` / `writeSync(fd,ptr,len)->i32` over WASI
  `fd_read`/`fd_write`; owns+exports the shared linear memory (mirrors
  `node-process.wat`). **`scripts/build-node-fs-shim.mjs`** assembles it in-process
  (binaryen), mirroring `build-node-process-shim.mjs`.
- **Codegen** (`src/codegen/index.ts`, `src/codegen/node-process-api.ts`,
  `src/codegen/context/{types,create-context}.ts`,
  `src/codegen/expressions/calls.ts`): when `--target wasi --link-node-shims` and
  the program imports `readSync`/`writeSync` from `node:fs`, register imports
  against module `"node:fs"` (members `readSync`/`writeSync`, pointer ABI
  `(fd,ptr,len)->i32`) + the shared memory; lower the calls to those imports via
  `tryCompileNodeFsCall` (GC-Uint8Array copy path + linear-backed zero-copy path;
  positional and `{offset,length}` options forms; `length` defaults to
  `buf.length - offset`). Memory ownership: a node:fs-only program (no
  process/console IO) has the node-fs shim own the memory; otherwise node-process
  owns it and node-fs links against the same bytes.
- **Path-based fs rejected under WASI**: `PATH_BASED_FS_FNS` (readFileSync, …)
  produce a structured compile error under `--target wasi` (no filesystem).
- **#1886 linear analysis** (`src/codegen/linear-uint8-analysis.ts`):
  `ioBufferArgIndex` now recognizes `readSync(fd,buf,…)`/`writeSync(fd,buf,…)` as
  byte-I/O buffer sinks (buffer at arg 1), keeping buffers linear-safe so the
  Slice-C signature rewrite of element-only helpers stays consistent.
- **Checker** (`src/checker/index.ts`): `node:fs` gets fd-based `readSync`/
  `writeSync` signatures (positional + options form) in the synthetic `.d.ts`;
  other node:fs members stay permissive `any`.
- **host-import-allowlist**: `node:fs` added to `ALWAYS_ALLOWED_IMPORT_MODULES`
  (a linkable interface, not a JS-host binding).
- **Example + docs**: `nm_js2wasm.ts` rewritten to `node:fs`; `README.md` updated;
  new `NODE-FS-SHIM.md`; `smoke-test.sh` builds + preloads `node-fs.wasm`.

## Test Results

- `tests/issue-2631-node-fs-fd-shim.test.ts` — 6/6 pass (import shape, round-trip,
  over-read safety, fd=2 routing, path-based rejection, non-WASI no-op).
- `tests/issue-1886*.test.ts` — pass (updated for the new example shape).
- `tests/issue-2524-node-process-shim.test.ts` — pass (unaffected).
- `tests/issue-2526-atomic-frame-writes.test.ts` — pass (atomic framing preserved;
  updated to link the node-fs shim).
- `examples/native-messaging/smoke-test.sh` — PASS under real wasmtime 44
  (byte-exact frame + clean stderr).
- The example runs unmodified under real `node` (tsx): byte-exact stdout frame +
  clean stderr telemetry.

## Design note for follow-up

The narrow `readSync(fd,ptr,len)->i32` ABI keeps the **fd** parameter (the
tech-lead message's `(ptr,len)` restatement dropped it) because fd is essential:
`writeSync(2, …)` must route stderr telemetry to fd 2, distinct from stdout fd 1
— the whole point of #389's stderr gap. The ABI can be widened to more of
`node:fs` later. Separately, the landed `js2wasm:node-process` shim should be
renamed `node:process` for naming consistency (tech-lead will file separately;
NOT touched here).
