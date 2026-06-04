---
id: 1886
title: "Linear-backed Uint8Array for WASI I/O buffers (escape analysis) — avoid GC↔linear copies, match AssemblyScript"
status: ready
sprint: Backlog
created: 2026-06-04
updated: 2026-06-04
priority: medium
feasibility: hard
reasoning_effort: high
task_type: performance
area: codegen
language_feature: typed-arrays
goal: performance
related: [1863, 1527, 389]
---
# #1886 — Linear-backed `Uint8Array` for WASI I/O buffers

**Source:** GitHub issue #389. guest271314's AssemblyScript host
(`nm_assemblyscript_component.wat`) is faster than js2wasm on the same workload;
the `.wat` shows why, and it points at a concrete, *targeted* optimization.

## Why AssemblyScript is faster (measured + confirmed from its `.wat`)

AssemblyScript uses **linear memory exclusively** — no WasmGC, no `array.new`/
`array.copy`/`struct.new`. Its message buffer *is* linear memory, so `fd_read`
reads **directly into** it and `fd_write` writes **directly from** it: **zero
copies**, no GC-heap instantiation.

js2wasm's `--target wasi` uses the **WasmGC backend**: `Uint8Array` is a GC
array. But WASI `fd_read`/`fd_write` can only touch *linear* memory, so every
read/write pays an element-wise copy js2wasm-side:
- `fd_read` lands bytes in a linear scratch region → copied element-by-element
  **into** the GC array;
- the GC array is copied element-by-element **back** to linear memory →
  `fd_write`.

Plus the GC module needs `-W gc=y` and GC-heap setup (slower cold start — which
dominates the 1 MiB `connectNative` benchmark). The streaming example host
(landed) removes body retention and the slow `array.copy` (24 MB / ~0.42 s for
64 MiB), but it **cannot** remove these GC↔linear copies — they're inherent to
the WasmGC backend.

## The optimization (not a global backend switch)

Selectively back a `Uint8Array` by **linear memory** when analysis proves it is
a plain I/O buffer that does not need GC — keep GC arrays everywhere else.

A `new Uint8Array(n)` is "linear-safe" iff it never escapes to a GC-requiring
use (stored in a GC struct/array, returned as a ref, captured, etc.) and is only
indexed / passed to `process.stdin.read` / `process.stdout.write`. For such an
array:
- allocate it in **linear memory** as `(ptr, len)`;
- `process.stdin.read(buf, off)` → `fd_read` straight into `ptr+off` (no copy);
- `process.stdout.write(buf)` → `fd_write` straight from `ptr` (no copy);
- `buf[i]` → a linear load/store.

When the analysis can't prove safety, fall back to the GC array (today's
behavior). GC stays the default; linear is used only where it's a pure buffer —
"without changing this for cases where it's not needed." Stays within the
"mimic standard Node APIs" rule: it's a transparent optimization of plain
`Uint8Array` + `process.stdin/stdout`, no bespoke builtin.

## What it requires

1. **Escape/usage analysis** for typed arrays — mark a `Uint8Array`
   "linear-safe" iff it never escapes to a GC-requiring context. (The
   typed-array slice of general escape analysis.)
2. **A linear allocator** for these buffers — the WASI output already has a
   linear memory and a (currently dead) `$__wasi_bump_ptr` global; wire up a
   real bump/arena (a per-port-loop arena reset suits short-lived I/O buffers).
3. **Codegen** so indexing + the `stdin.read`/`stdout.write` intrinsics operate
   on a linear-backed array, with a clean GC fallback.

Overlaps the `codegen-linear` backend (#1527) and general escape analysis, but
as an analysis-driven optimization rather than a target choice.

## Acceptance criteria

- A WASI byte-I/O host (e.g. `examples/native-messaging/nm_js2wasm.ts`) whose
  `Uint8Array` buffers are provably I/O-only compiles with **no GC↔linear
  copies** on the read/write path; verified in the `.wat` (no element-wise
  GC→linear loop around `fd_read`/`fd_write`).
- 64 MiB round-trip wall time within ~2× of the AssemblyScript host.
- No correctness/behavior change for `Uint8Array` that does escape (GC fallback
  intact); existing tests + `smoke-test.sh` pass.
