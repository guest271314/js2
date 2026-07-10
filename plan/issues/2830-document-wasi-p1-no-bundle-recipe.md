---
id: 2830
title: "Lower DataView/Uint8Array-over-WASI-memory to linear ops; rewrite wasi_p1 to standard DataView (drop the wasm:memory ghost intrinsic)"
status: done
sprint: 69
priority: medium
area: codegen
task_type: feature
assignee: ttraenkler/senior-dev-2830
completed: 2026-07-03
related: [389, 2835, 1886, 1783, 2803, 2840, 3012]
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
_both_ plain JS _and_ compiled wasm, the offsets must be **linear-memory** offsets
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
`DataView`/buffer _is_ the module's linear memory" in WASI mode (e.g. a recognized
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
     collection _alongside_ the low-level `wasm:memory` `wasi_p1` (both stay: raw =
     max efficiency, DataView = runs in a plain JS runtime) — NOT a replacement.
     Either way, keep the `--no-bundle` docs (below) for whichever intrinsic host
     remains.

## Fallback (the prior docs-only scope, if the lowering proves infeasible or regresses efficiency)

Document the `wasi_p1` build recipe in `examples/native-messaging/README.md`:
`bun build --no-bundle`, or `--external wasi_snapshot_preview1 --external 'wasm:memory'`
(the form `scale-test.mjs` already uses), with the ghost-import ergonomics tradeoff.

## Sizing verdict & design bank (senior-dev, 2026-07-03, honest measure-first pass)

**Delivered this PR (the documented Fallback):** the `wasm:memory` /
`wasi_snapshot_preview1` ghost-import bundling recipe + ergonomics tradeoff is now
in `examples/native-messaging/README.md` (new subsection under "Build to `.wasm`").
Byte-inert to the compiler.

**Deferred (the full DataView-linear lowering):** assessed **substrate-scale**, not
a bounded win. Deferred rather than half-built, per the "bank a design, don't force
a substrate change late in a budget window" discipline — and specifically because
it would touch late-import / funcIdx-adjacent codegen, a class this session has
repeatedly caught silently regressing. What the measure-first pass established:

1. **DataView is 100% WasmGC-backed today, with no linear-memory representation.**
   `new DataView(new ArrayBuffer(N))` lowers to a `$__vec_i32_byte` struct/array
   (packed `i8` after #2835); every accessor (`recoverDvBacking` in
   `src/codegen/dataview-native.ts`) recovers a **GC array + base offset** and does
   `array.get_u` / `array.set`. The DataView value at runtime is an externref/struct
   ref — it carries **no notion of "I am the module's own linear memory."** A naive
   source swap (just use `DataView`) compiles to a GC buffer that `fd_read`/`fd_write`
   (which address _linear_ memory via the iovec pointer) cannot see → the compiled
   raw-WASI host breaks. (The issue's own "confirm with a probe" — confirmed.)

2. **The #1886 linear-`Uint8Array` infra does NOT fit `wasi_p1`'s model.** The
   `src/codegen/linear-uint8-*.ts` machinery (1,340 LoC) is **Uint8Array-only** (zero
   DataView awareness) and uses **escape analysis that allocates a per-buffer
   `(ptr,len)` pair as function locals** — and per #2840 it **cannot back a
   module-scope buffer** at all. `wasi_p1`'s model is the opposite: **one whole-memory
   buffer with hand-laid-out FIXED absolute offsets** (`IOV=0`, `RESULT=8`,
   `INBUF=4096`, …) accessed across **many** functions. That needs a _different_
   designation (a whole-memory view whose `byteOffset` base is a compile-time
   constant, absolute offsets, no ptr/len threading), not the #1886 local-escape
   model. So "reuse #1886" is not the shortcut the issue hoped.

3. **What a real implementation requires** (a new parallel backing-store
   representation — the substrate cost):
   - A recognizer for a source construct that designates "this buffer _is_ the
     module's linear memory" in WASI mode — e.g. a module-scope
     `const mem = new ArrayBuffer(N); const dv = new DataView(mem)` treated as
     base-0 linear, with `ArrayBuffer(N)` sizing the module's **initial memory
     pages** (`ceil(N/65536)`) instead of a GC `array.new`.
   - Type/value tracking so **every** `dv.getUint32(off, le)` / `dv.setUint32(off,
val, le)` call site knows to take the **linear path** (inline
     `i32.load`/`i32.store`/`i32.load8_u`/`i32.store8` at `off`, with runtime
     `littleEndian` handling and byte-swap for BE) rather than the GC
     `recoverDvBacking` path — a per-view discriminant threaded through locals,
     params (cross-function, like #1886's helper-arg rewrite), and returns.
   - The lowering is the _easy_ part (it's exactly what `emitMemAccessor` in
     `src/codegen/raw-wasi-api.ts` already emits for `store32`/`load32`); the
     **representation + whole-program propagation of "which DataView is linear" is
     the hard, hazardous part.**

4. **Acceptance #2 ("bundles cleanly / runs in plain JS") has an unresolved tension
   even after the lowering.** Dropping `wasm:memory` does **not** make `wasi_p1`
   bundle without externals: `fd_read`/`fd_write` are imported from
   `wasi_snapshot_preview1`, an **equally unresolvable ghost import** to a JS bundler
   (confirmed: `scale-test.mjs` passes `--external wasi_snapshot_preview1 --external
'wasm:memory'` — BOTH). A truly JS-runnable/clean-bundling raw host would also
   need a resolvable WASI shim for `fd_read`/`fd_write` — which is precisely what the
   `node:fs` / `node:process` hosts already are. So the DataView rewrite alone cannot
   fully satisfy #2 for the raw-WASI host; the acceptance needs re-scoping.

**Outcome (tech-lead adjudicated 2026-07-03):** #2830 **closes `done`** on the
Fallback — the bundling recipe + design bank are real shipped value, not a punt.
The full DataView-linear lowering is carried forward as **#3012** (`feasibility:
hard`, `[ARCH]`): it carries the design above (whole-memory linear-view
representation + per-view linear/GC discriminant propagation + `ArrayBuffer(N)`→
initial-pages) and **re-scopes acceptance #2** around a `wasi_snapshot_preview1`
shim (the original "bundles cleanly from the DataView rewrite alone" framing was
found unachievable regardless of the DataView work). #3012 must get an architect
spec before any implementation attempt.

## Related

- #389 — reporter's `wasm:memory` "ghost code" feedback + his JS `DataView` POC.
- #1783 / #2803 — JavaScript-first parity (this advances it).
- #1886 — linear-safe `Uint8Array` analysis (reuse). #2835 — packed-i8 byte buffer.
- #2840 — proof #1886's linear-`Uint8Array` infra can't back a module-scope buffer.
