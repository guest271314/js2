---
id: 2633
title: "Migrate synchronous std-IO off the hallucinated process.std* surface onto node:fs readSync/writeSync"
status: done
sprint: 65
assignee: ttraenkler/agent-a0c10078166a3b3a5
completed: 2026-06-24
depends_on: [2631, 1968]
feasibility: medium
---

## Problem

The synchronous std-IO surface js2wasm exposed under `--target wasi
--link-node-shims` was built on a **hallucinated** API:

- `process.stdin.read(buf, offset)` — a synchronous, buffer-filling read that
  matches **no real Node API**. Node's `process.stdin` is an async `Duplex`
  stream with no such method (the loopdive/js2#389 reporter's point). It was
  lowered (inline `fd_read` or, under `--link-node-shims`, the bespoke
  `js2wasm:node-process::stdin_read`) into the caller's typed buffer.
- The genuinely Node-matching synchronous fd primitives are `fs.readSync` /
  `fs.writeSync` (fd 0/1/2), which #2631/#1968 landed as the `node:fs` shim
  interface. (This is also what Javy uses: `Javy.IO.readSync`.)
- The `js2wasm:node-process` shim (`stdin_read`/`stdout_write`/`stderr_write` +
  its own linear memory) duplicated, fd-fixed, the exact mechanism the new
  `node:fs` `readSync`/`writeSync(fd, ptr, len)` shim already provides.

So the fake surface should be replaced with the real one, and the duplicate
shim retired.

## Acceptance criteria

- `process.stdin.read(buf, offset)` is **no longer recognised** — it errors with
  a clear message directing the user to `node:fs` `readSync(0, buf, …)`.
- `process.stdout.write` / `process.stderr.write` (real Node Writable-stream
  `write`) keep working. Under `--link-node-shims` they lower to `node:fs`
  `writeSync(1|2, …)`; on the inline WASI path they keep the canonical
  `wasi_snapshot_preview1.fd_write` lowering.
- `console.log` / `console.warn` / `console.error` under `--link-node-shims`
  lower to `node:fs` `writeSync(1|2, …)`.
- The bespoke `js2wasm:node-process` shim is retired: the `.wat`, its
  `NODE-PROCESS-SHIM.md`, `scripts/build-node-process-shim.mjs`, the
  `nodeIo*Idx` ctx fields, the index.ts import registration, and the
  `host-import-allowlist` entry are all removed.
- `--link-node-shims` CLI help + README describe `node:fs`, not node-process.
- **Byte-neutral** for every program that does not use process/node:fs IO.

## Resolution

Implemented in PR for #2633. Under `--link-node-shims`, `node:fs` now owns the
single shared linear memory and provides `readSync`/`writeSync`; all std-IO
(console.log/warn/error, process.stdout/stderr.write) lowers to
`writeSync(fd, ptr, len)` with the fd pushed explicitly. The
`process.stdin.read` recognition was removed from all paths and now emits a
compile error pointing at `node:fs` `readSync`. The `js2wasm:node-process`
shim, its build script, doc, ctx fields, and allowlist entry were deleted.

### Decision on `process.std*.write` lowering

`process.stdout.write`/`process.stderr.write` are real Node APIs, kept working:
- **`--link-node-shims`**: lowered to `node:fs` `writeSync(1|2, ptr, len)`
  (reusing the landed #1968 mechanism) — the directive's target.
- **inline WASI (no `--link-node-shims`)**: kept on the canonical
  `wasi_snapshot_preview1.fd_write` ABI. There is no `node:fs` shim inline (the
  inline path is self-contained and does not link a separate module), and
  `fd_write` is the real WASI ABI, not the hallucinated shim, so this stays.

`process.stdin.read` had no real replacement on the inline path (node:fs
`readSync` requires `--link-node-shims`), so the inline synchronous-stdin
capability is intentionally dropped along with the fake surface; tests that
exercised it (#1653, parts of #1751/#1886/wasi) were migrated to `node:fs`
`readSync` under `--link-node-shims` or retired.

### Validation (per the #1968 batch-context lesson)

- **Batch byte-neutrality**: compiled 121 test262 files (addition, array-literal,
  for, Array.map, Object.defineProperty, types/number) with vs without the
  change and diffed per-file wasm SHA — **byte-identical** wasm/CE for every file.
- **runTest262File host-sample**: ran 70 host-language files spanning the #1968
  hazard classes (eval-code/direct, global-code, for-await-of SyntaxError/parse
  negatives, addition positives, built-ins/eval) on branch vs main and compared
  `.status` — **zero status regressions** (48 pass / 22 fail identical both sides).
- `npx tsc --noEmit` clean; `biome lint` clean; `check:ir-fallbacks` OK.
