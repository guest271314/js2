# `node:fs` host-import ABI (one contract, swappable providers)

> Status: **pinned** (2026-06-23, #1772 Phase 0). Anchor members `readSync` /
> `writeSync`. Companion to `plan/issues/1772-edgejs-node-wasi-shim-spike.md`
> (`## Phase 0 — ABI`) and the landed shim work in #2631.

## Why this exists

Node-shaped host APIs (`fs.readSync`, `process.stdout.write`, …) must **not**
accrete as ad-hoc special cases in the generic compiler. The clean model
(`feedback_node_apis_via_per_module_shim_not_builtin`):

1. a program *imports* a node module surface
   (`import { readSync } from "node:fs"`),
2. the compiler emits a **wasm import** declaring the dependency by the **real
   module + member name** (`(import "node:fs" "readSync" …)`), import-scoped to
   only the members actually used,
3. that import is satisfied at **link time** by any provider honoring one fixed
   ABI. The module declares **what** host API it needs, never **how** it is
   satisfied.

This document pins that fixed ABI for the fd-based synchronous `node:fs` core so
that every provider — a pure-WASI `.wat` shim, a JS `edge.js` adapter delegating
to real `node:fs`, or a WASI polyfill — is interchangeable **by construction**.

## The pointer-ABI (anchor members)

Import module name: **`"node:fs"`**. Member names are the **real Node names**.
Each member is a flat numeric function over the module's shared linear memory —
nothing GC-typed crosses the link.

| Member      | Wasm import signature               | Semantics |
|-------------|-------------------------------------|-----------|
| `readSync`  | `(fd i32, ptr i32, len i32) -> i32` | Read up to `len` bytes from descriptor `fd` into `mem[ptr, ptr+len)`. Returns the count actually read; `0` means EOF. **MUST NOT** write past `ptr+len`. |
| `writeSync` | `(fd i32, ptr i32, len i32) -> i32` | Write `mem[ptr, ptr+len)` to descriptor `fd`. Returns the count actually written. A short write is legal (callers loop until drained). |

### `fd` is load-bearing

`fd` is an integer descriptor: `0`=stdin, `1`=stdout, `2`=stderr. A provider
**must** route by it. In particular `writeSync(2, …)` writes telemetry/diagnostics
to **stderr**, off the stdout protocol stream — a provider that collapses all
writes onto stdout is **non-conforming** and corrupts framed protocols (e.g.
Chrome Native Messaging).

### fd-based, not path-based

These members are fd-based and **filesystem-free**: no `path_open`, no preopens,
no filesystem. Path-based `node:fs` (`readFileSync(path)`, `open`, …) is a
**different capability tier** that needs a filesystem (`--allow-fs`/preopens) and
is **rejected** under `--target wasi`. Keeping the fd core filesystem-free is what
makes it portable across all three host classes today.

## Two contracts, one bridge

There are two distinct surfaces, and the compiler bridges between them:

- **Source-level (Node-shaped) contract** — what the `.ts` author writes:
  `readSync(0, buf, { offset, length })`, `writeSync(1, buf, offset)`. These are
  the *real* Node signatures, so the **same source file runs unmodified under
  real `node`** (where `node:fs` is the real module).
- **Wasm-link (pointer) contract** — what crosses the module boundary:
  `(fd, ptr, len) -> i32` over shared memory, as tabled above.

The compiler lowers the GC/linear `Uint8Array` argument to a `(ptr, len)` pair
over the shared memory and emits the import call. On the native-Node path, the
**`edge.js` adapter** performs the inverse: it receives `(fd, ptr, len)`, wraps
the byte range as a `Buffer`/`Uint8Array` view, and calls the real
`fs.readSync(fd, buf, 0, len, null)` / `fs.writeSync(fd, buf)`.

## Memory-ownership / linking model

### Today — shim-owned exported memory

Mirrors `examples/native-messaging/node-fs.wat`:

1. The **provider owns + exports** the linear memory:
   `(memory (export "memory") 3)` (min 3 pages; grows on demand).
2. The **user module imports** memory index 0 from `"node:fs"` plus the IO
   functions it uses. It declares **no** memory of its own.
3. **No instantiation cycle.** Instantiate the provider first (it imports only
   its own backing — `wasi_snapshot_preview1` for the `.wat` shim; *nothing* for
   `edge.js`), then instantiate the user module with `{ memory, readSync,
   writeSync }` taken from the provider's exports.
4. The provider reads/writes the user's bytes over the **same** memory. The
   `.wat` shim builds its WASI iovec in reserved scratch at `mem[0, 12)` and
   issues the syscall; `edge.js` reads/writes the `[ptr, ptr+len)` range directly
   from JS (no scratch needed).

Since #2633, **all** std-IO under `--link node:fs` flows through `node:fs`:
`console.log`/`warn`/`error` and `process.stdout`/`stderr.write` lower to
`writeSync(1|2, …)`, and synchronous stdin is `readSync(0, …)`. `node:fs` owns
the single shared linear memory; the bespoke `js2wasm:node-process` shim — and
the hallucinated `process.stdin.read(buf, offset)` it backed — was retired.

### Durable form — #2527 core-wasm linking

Shim-owned-memory is a stop-gap that works on any plain
`WebAssembly.instantiate`. The durable form is WebAssembly core-module/component
linking (#2527): user module + provider linked with an explicitly shared memory,
so neither side hard-codes "who owns memory". **The pointer-ABI per member is
unchanged by that migration** — only the memory-binding mechanism changes.

## Provider contract table

One compiled binary, three host classes, one ABI. Compatibility holds **by
construction iff every provider honors the pointer-ABI above.**

| Host class | Provider | How it satisfies `readSync(fd, ptr, len) -> i32` |
|---|---|---|
| **Pure WASI** (wasmtime, no JS) | `node-fs.wat` / `.wasm` shim (#2631) | WASI `fd_read` / `fd_write` over the shim-owned memory (iovec in `mem[0,12)`). |
| **Native Node** (JS, no WASI) | **`edge.js`** | reads/writes `mem[ptr, ptr+len)` from JS; calls real `fs.readSync(fd, buf, 0, len, null)` / `fs.writeSync(fd, buf)`; returns the count. |
| **JS + WASI** (browser / Node-WASI) | `edge.js` over a WASI polyfill | delegates to a `fd_read`/`fd_write` polyfill or platform fd APIs over the same memory. |

## Wrinkles that decide real compatibility

1. **Calling-convention impedance.** Real `fs.readSync(fd, buffer, offset,
   length, position)` ≠ the wasm `readSync(fd, ptr, len)`. So native Node is
   **never a direct provider** — it always needs `edge.js` to translate
   pointer-ABI ↔ Buffer-ABI over the exported memory.
2. **Type surface ≫ runtime surface.** `@types/node` types thousands of members;
   only the subset with a shim/adapter is *linkable*. Type extraction (#1772
   Phase 2) must gate against a **capability map** (`@types/node` member →
   provider fn → host classes that can provide it) so a program either links or
   gets a precise "no provider" error — never a silent link failure.
3. **Async ≠ sync.** Sync fd APIs port trivially. Node's async surface
   (`process.stdin` Readable, `fs.promises`) needs the event loop (#2632); the
   contract can stay identical but the pure-WASI provider drives `poll_oneoff`
   while `edge.js` borrows the JS host's loop. **Out of scope here** (Phase 3).

## Verdict on the JS-provider substrate

`edge.js` is a **thin, dependency-free adapter** (≈ two closures over the
instance's exported memory), not a framework. It is the right substrate precisely
because it is thin: the only job is the pointer-ABI ↔ Buffer-ABI translation in
wrinkle #1, which is irreducible. A heavier substrate would add nothing the ABI
doesn't already pin. See #1772 Phase 1 for the byte-identical dual-provider proof.
