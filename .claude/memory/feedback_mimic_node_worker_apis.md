---
name: feedback_mimic_node_worker_apis
description: Expose host capabilities via standard Node.js / Web Worker APIs — never invent bespoke compiler builtins like readStdin()/writeStdout()
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0ffbd21c-b73d-429a-a76d-4fb742ea9794
---

Do NOT invent bespoke compiler-builtin globals/functions for host capabilities (e.g. `readStdin()`, `writeStdout()`). Instead, the compiler should **mimic standard runtime APIs** that developers already know and that port across runtimes:
- **Node.js**: `process.stdin` / `process.stdout` / `process.stderr` (`.read()`, `.write()`, `.on('data'|'readable')`), `process.argv`, `process.env`, etc.
- **Web Worker / messaging**: `postMessage()` / `onmessage` / `self` where a message-passing model fits.

**Why:** An external contributor (guest271314, Native Messaging domain expert) hit our bespoke `declare function readStdin(): string;` in the #1530 example and said "I don't see an implementation" — because it's a js2wasm-only intrinsic, not a real API. Bespoke builtins are unportable, unrecognizable, and undocumentable; real Node/Worker code can't be dropped in. Guest's own reference hosts (nm_typescript.ts, nm_host.js) are written against `process.stdin`/`process.stdout` and run unmodified across node/deno/bun/tjs. The compiler's job is to **compile away** standard APIs to WASI/Wasm, not to require users to learn intrinsics.

**How to apply:**
- New host-capability work exposes the standard API surface, lowering it to WASI (`fd_read`/`fd_write`/etc.) or host imports under the hood.
- `readStdin()` (the existing builtin) should be **deprecated/replaced** by `process.stdin` reads — this makes #1653 (`process.stdin.read(buffer, offset)`) the keystone, not an add-on. #1651 already added `process.stdout.write` (good — keep that direction). #1617's bespoke `writeStdout(bytes)` builtin is the WRONG shape — superseded by `process.stdout.write`.
- Examples (esp. #1530 Native Messaging) must be written in standard Node/Worker style so they're copy-paste-portable and match references like guest's nm_typescript.ts.
- See [[feedback_compile_away]] — same spirit: resolve standard semantics to Wasm, don't emulate with custom surface.
