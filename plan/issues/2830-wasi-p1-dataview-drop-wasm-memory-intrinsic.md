---
id: 2830
title: "Lower DataView/Uint8Array-over-WASI-memory to linear ops; rewrite wasi_p1 to standard DataView (drop the wasm:memory ghost intrinsic)"
status: ready
sprint: current
priority: medium
area: codegen
task_type: feature
related: [389, 2835, 1886, 1783, 2803]
---

# Replace the `wasm:memory` ghost intrinsic with a standard `DataView` surface the compiler lowers to linear ops

## Problem

`examples/native-messaging/nm_js2wasm_wasi_p1.ts` does raw `wasi_snapshot_preview1`
fd I/O and lays out its iovec / length fields by hand using
`import { store32, load32, store8, load8 } from "wasm:memory"`. Those are js2wasm
**compile-time intrinsics** — they lower to inline `i32.store`/`i32.load` over the
module's own linear memory and have **no resolvable JS module**. Two costs:

1. **Bundling friction** — bun/esbuild/`deno bundle` choke on the unresolvable
   `wasm:memory` import (needs `--no-bundle` / `--external`). The loopdive/js2#389
   reporter hit this.
2. **The source is wasm-only** — unlike the other three hosts (whose `.js` runs
   unmodified under node/deno), `wasi_p1`'s source can't run in a plain JS
   runtime, because `store32`/`load32` are "ghost code" with no JS implementation.
   This cuts against the JS-first-parity goal (#1783/#2803) and our own
   "mimic standard Node/Web APIs, no bespoke builtins" principle.

The #389 reporter demonstrated the fix in JS: implement `load8`/`store8`/`load32`/
`store32` as **`DataView.getUint8`/`setUint8`/`getUint32`/`setUint32`** over a
shared `ArrayBuffer`, with "pointers" being plain integer offsets into that
buffer. His JS reimplementation runs the same framing logic in a pure JS runtime
(and, he notes, with a resizable `ArrayBuffer` for stdio in the browser).

## The insight / why a naive swap doesn't compile today

His model is "one buffer, two accessors": integer offsets + a `DataView` over the
same `ArrayBuffer` the WASI shim reads/writes. To make **one source** work as
*both* plain JS *and* compiled wasm, the offsets must be **linear-memory** offsets
and the `DataView` accessors must lower to inline `i32.load/store` over the
module's memory — exactly what `wasm:memory` does now.

Today they don't: js2wasm backs `DataView`/`ArrayBuffer` with a **WasmGC array**
(`$__vec_i32_byte`, packed `i8` after #2835), **not** linear memory. So a naive
source swap (just use `DataView`) would compile to a GC-backed buffer that
`fd_read`/`fd_write` (which address linear memory via the iovec pointer) can't
see → the compiled host breaks. (Confirm this with a probe before implementing.)

## Goal

Teach the compiler to lower a `DataView` (and/or linear-safe `Uint8Array`)
constructed over the **WASI module's own linear memory** to inline
`i32.load*`/`i32.store*`, then rewrite `nm_js2wasm_wasi_p1.ts` to use that standard
surface and **drop the `wasm:memory` import entirely**. Result:

- standard ECMA-262 `DataView` surface → the `wasi_p1` **source runs in a plain JS
  runtime** (node/deno/bun/browser), satisfying JS-first parity;
- compiler lowers the accessors to linear ops → the **compiled `--target wasi`
  module still works** (valid iovec pointers into linear memory);
- **no `wasm:memory` ghost import** → bundles cleanly, no bespoke builtin.

Open design question for the implementer: how the source designates "this
`DataView`/buffer *is* the module's linear memory" in WASI mode (e.g. a recognized
`new DataView(new ArrayBuffer(N))` whose offsets are linear, or a
`memory.buffer`-style handle). Reuse the linear-`Uint8Array` analysis (#1886) and
the packed-byte machinery (#2835) where possible.

## Acceptance

1. `nm_js2wasm_wasi_p1.ts` uses **standard `DataView`/`Uint8Array`** for all
   iovec/length/byte access — **no `import … from "wasm:memory"`**.
2. **Runs in plain JS** — the unmodified `.ts`/bundled `.js` round-trips a framed
   native-messaging message under `node`/`deno`/`bun` (no ghost-import error,
   bundles without `--no-bundle`).
3. **Compiled `--target wasi` still works** — `scale-test.mjs` passes byte-exact
   for all four hosts at 1/64/128/256 MiB under real wasmtime 46.
4. **Efficiency comparison vs the current low-level `wasm:memory` `wasi_p1`** — the
   DataView-based host must be **roughly as efficient** as today's intrinsic-based
   one. Measure and report, head-to-head, current vs new:
   - **binary size** (`.wasm` bytes),
   - **throughput** (wall-time at 1/64/128/256 MiB),
   - **peak RSS** (at 128/256 MiB).
   `wasi_p1` is currently the **leanest and fastest** of the four hosts (probe-2829:
   ~46% smaller, ~3× faster, ~38% less RSS than node_fs). If the DataView lowering
   emits the same inline `i32.load/store` as the `store32`/`load32` intrinsics this
   should be a wash; quantify and confirm.
   - **If efficiency holds → the DataView host REPLACES `nm_js2wasm_wasi_p1.ts`**
     (one host, JS-runnable + standalone, no ghost import).
   - **If it materially regresses → ship it as an ADDITIONAL variant** in the host
     collection *alongside* the low-level `wasm:memory` `wasi_p1` (both stay: raw =
     max efficiency, DataView = runs in a plain JS runtime) — NOT a replacement.
   Either way, keep the `--no-bundle` docs (below) for whichever intrinsic host
   remains.

## Fallback (the prior docs-only scope, if the lowering proves infeasible or regresses efficiency)

Document the `wasi_p1` build recipe in `examples/native-messaging/README.md`:
`bun build --no-bundle`, or `--external wasi_snapshot_preview1 --external 'wasm:memory'`
(the form `scale-test.mjs` already uses), with the ghost-import ergonomics tradeoff.

## Related

- #389 — reporter's `wasm:memory` "ghost code" feedback + his JS `DataView` POC.
- #1783 / #2803 — JavaScript-first parity (this advances it).
- #1886 — linear-safe `Uint8Array` analysis (reuse). #2835 — packed-i8 byte buffer.
