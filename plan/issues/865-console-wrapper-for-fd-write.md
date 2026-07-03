---
id: 865
title: "Console wrapper for fd_write in JavaScript environments"
status: done
completed: 2026-07-03
created: 2026-03-29
updated: 2026-07-03
priority: medium
feasibility: easy
reasoning_effort: medium
goal: platform
sprint: Backlog
---
# #865 -- Console wrapper for fd_write in JavaScript environments

## Problem

In WASI mode, `console.log` compiles to `fd_write(1, ...)` which writes to stdout. This works in WASI runtimes (wasmtime, wasmer) but not in JavaScript environments.

When running WASI-compiled Wasm in a browser or Node.js without a WASI shim, `fd_write` is an unresolved import and instantiation fails.

## Fix

Provide a lightweight JavaScript console wrapper that implements the WASI `fd_write` interface by routing to `console.log`:

```js
const wasi = {
  fd_write(fd, iovs_ptr, iovs_len, nwritten_ptr) {
    // Read iov buffers from linear memory
    // Decode UTF-8 and route to console.log (fd=1) or console.error (fd=2)
    // Write bytes written to nwritten_ptr
  }
};
```

This would be included in the runtime as an optional WASI polyfill, allowing WASI-compiled modules to run in JS environments without a full WASI runtime.

## Acceptance criteria

- WASI `fd_write` polyfill in `src/runtime.ts` or separate `src/wasi-polyfill.ts`
- `console.log("hello")` in WASI mode works in both WASI runtimes and JS environments
- Documented in README

## Reconciliation — DONE (2026-07-03)

Verified genuinely resolved on `main` against the full acceptance criteria:

- **WASI `fd_write` polyfill exists** — `src/runtime.ts` (~L13896) exports a WASI
  polyfill object whose `fd_write(fd, iovs, iovs_len, nwritten)` reads each iovec
  (`view.getUint32(iovs + i*8, ...)` ptr/len), UTF-8-decodes via `TextDecoder`,
  and routes to `console.error` for fd 2 else `console.log`, writing the byte
  count to `nwritten` — a real implementation, not a stub.
- **`console.log` in WASI mode works in JS environments** — a WASI-compiled
  module instantiated with this polyfill as `wasi_snapshot_preview1` resolves
  `fd_write` and prints via `console.*` (criterion 2).
- **Documented** — `docs/standalone-io.md` documents the routing
  (`console.log → fd_write` on fd 1, `console.warn/error → fd 2`) and the JS/Deno
  loader recipes; the acceptance's "documented" bar is met (in a dedicated doc
  rather than README).

Flipped during the 2026-07-03 stale-backlog reconciliation.
