---
id: 3012
title: "Lower a whole-memory DataView/ArrayBuffer to inline linear ops (WASI), rewrite wasi_p1 off the wasm:memory intrinsic"
status: ready
sprint: Backlog
priority: medium
area: codegen
task_type: feature
feasibility: hard
reasoning_effort: max
language_feature: typed-arrays
goal: standalone
related: [389, 2830, 2835, 1886, 2840, 1783, 2803]
---

# Lower a whole-memory `DataView`/`ArrayBuffer` to inline linear ops (WASI)

Split out of **#2830** (which shipped the documented bundling-recipe fallback +
this design bank). This is the substrate-scale feature half: teach the compiler to
lower a `DataView` (and/or linear-safe `Uint8Array`) constructed over the **WASI
module's own linear memory** to inline `i32.load*`/`i32.store*`, then rewrite
`examples/native-messaging/nm_js2wasm_wasi_p1.ts` to use that standard surface and
drop the `wasm:memory` ghost intrinsic.

**Do NOT dev-dispatch this directly — it needs an architect spec first (`[ARCH]`).**
This session's #2830 measure-first pass established the design below and flagged the
hazards; an architect must turn it into an exact `## Implementation Plan` (functions,
line numbers, Wasm patterns, per-view discriminant threading, edge cases) before any
implementation attempt.

## Why this is hard (the #2830 measure-first findings)

1. **`DataView` is 100% WasmGC-backed today, with no linear-memory representation.**
   `new DataView(new ArrayBuffer(N))` lowers to a `$__vec_i32_byte` struct/array
   (packed `i8`, #2835); every accessor (`recoverDvBacking` in
   `src/codegen/dataview-native.ts`) recovers a **GC array + base offset** and emits
   `array.get_u`/`array.set`. The DataView value at runtime is an externref/struct
   ref — it carries **no notion of "I am the module's own linear memory."** A naive
   source swap (just use `DataView`) compiles to a GC buffer that
   `fd_read`/`fd_write` (which address _linear_ memory via the iovec pointer) cannot
   see → the compiled raw-WASI host breaks.

2. **#1886's linear-`Uint8Array` infra does NOT fit `wasi_p1`'s model.** The
   `src/codegen/linear-uint8-*.ts` machinery (~1,340 LoC) is **Uint8Array-only** (no
   DataView awareness) and uses **escape analysis that allocates a per-buffer
   `(ptr,len)` pair as function locals**; per **#2840** it **cannot back a
   module-scope buffer** at all. `wasi_p1`'s model is the opposite: **one
   whole-memory buffer with hand-laid-out FIXED absolute offsets** (`IOV=0`,
   `RESULT=8`, `INBUF=4096`, …) accessed across **many** functions. That needs a
   _different_ designation, not the #1886 local-escape model.

## Design (banked from #2830 — architect to refine)

A **new parallel backing-store representation** for a DataView/ArrayBuffer that _is_
the module's linear memory:

- **Recognizer** — a source construct designating "this buffer is the module's
  linear memory" in WASI mode. Candidate: a module-scope
  `const mem = new ArrayBuffer(N); const dv = new DataView(mem)` treated as base-0
  linear, with `ArrayBuffer(N)` sizing the module's **initial memory pages**
  (`ceil(N/65536)`) instead of a GC `array.new`. (Open: a `memory.buffer`-style
  handle vs. the recognized-ctor form — architect decides.)
- **Per-view linear/GC discriminant, propagated whole-program** — every
  `dv.getUint32(off, le)` / `dv.setUint32(off, val, le)` call site must know to take
  the **linear path** (inline `i32.load`/`i32.store`/`i32.load8_u`/`i32.store8` at
  `off`, runtime `littleEndian` handling incl. BE byte-swap) instead of the GC
  `recoverDvBacking` path. The discriminant must thread through **locals, params
  (cross-function, like #1886's helper-arg rewrite), and returns.** This is the hard,
  hazardous part — it is late-import/funcIdx-adjacent; guard against silent stack /
  index regressions.
- **The lowering itself is the easy part** — it is exactly what `emitMemAccessor` in
  `src/codegen/raw-wasi-api.ts` already emits for `store32`/`load32`/`store8`/`load8`.
  Reuse that emission; the novelty is entirely in the representation + propagation.

## Acceptance

1. `nm_js2wasm_wasi_p1.ts` uses **standard `DataView`/`Uint8Array`** for all
   iovec/length/byte access — **no `import … from "wasm:memory"`**.
2. **Re-scoped (per #2830 finding):** the `wasi_p1` source runs in a plain JS runtime
   **when paired with a `wasi_snapshot_preview1` shim** — NOT "bundles cleanly from
   the DataView rewrite alone." Dropping `wasm:memory` alone does **not** make
   `wasi_p1` bundle without externals, because `fd_read`/`fd_write` from
   `wasi_snapshot_preview1` remain an **equally-unresolvable ghost import** to a JS
   bundler. So JS-runnability requires a resolvable WASI shim (a small JS
   `wasi_snapshot_preview1` polyfill / node WASI) supplying `fd_read`/`fd_write` over
   the same `ArrayBuffer` the DataView views. Deliverable: that shim + a round-trip of
   a framed native-messaging message under `node` (and, if cheap, `deno`/`bun`) with
   **no `wasm:memory` ghost-import error**.
3. **Compiled `--target wasi` still works** — `scale-test.mjs` passes byte-exact for
   all four hosts at 1/64/128/256 MiB under real wasmtime 46.
4. **Efficiency comparison vs the current `wasm:memory` `wasi_p1`** — binary size
   (`.wasm` bytes), throughput (wall-time at 1/64/128/256 MiB), peak RSS (at
   128/256 MiB). If the DataView lowering emits the same inline `i32.load/store` this
   should be a wash; quantify and confirm.
   - **Efficiency holds → the DataView host REPLACES `nm_js2wasm_wasi_p1.ts`.**
   - **Materially regresses → ship as an ADDITIONAL variant** alongside the raw
     `wasm:memory` `wasi_p1` (raw = max efficiency, DataView = runs in a plain JS
     runtime with the shim) — NOT a replacement.
     Keep the #2830 `--external`/`--no-bundle` docs for whichever intrinsic host remains.

## Related

- #2830 — parent; shipped the bundling-recipe fallback + this design bank.
- #389 — reporter's `wasm:memory` "ghost code" feedback + JS `DataView` POC.
- #1886 — linear-`Uint8Array` analysis (reference, but insufficient — see above).
- #2840 — proof #1886's infra can't back a module-scope buffer.
- #2835 — packed-i8 byte buffer backing `$__vec_i32_byte`.
- #1783 / #2803 — JavaScript-first parity (this advances it).
