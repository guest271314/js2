---
id: 1895
title: "Minimal .wat repro: WasmGC i8 array.copy vs element-loop vs linear memory.copy throughput (wasmtime vs Node/V8)"
status: done
completed: 2026-07-03
sprint: Backlog
created: 2026-06-05
updated: 2026-07-03
priority: medium
feasibility: easy
reasoning_effort: low
task_type: investigation
area: runtime-perf
language_feature: typed-arrays
goal: performance
related: [1863, 1886, 389]
---
# #1895 — Minimal `.wat` repro: GC `array.copy` vs element-loop vs linear `memory.copy`

## Problem

While optimizing the Native Messaging host (#389) and designing linear-backed
`Uint8Array` (#1886), we measured that **`array.copy` on an i8 WasmGC array is
dramatically slower than a hand-rolled element loop under wasmtime** — the native
bulk op, which is *supposed* to be the fast path, collapses. That single fact
drove a real design decision: the merged host builds each frame with an element
loop instead of `subarray` (which lowers to `array.copy`) specifically to avoid
this cliff (#1863).

This issue captures a **clean, minimal, self-contained `.wat`** that reproduces
the gap in isolation (no compiler, no js2wasm) and compares the *identical*
module across **wasmtime v44.0.2 (CI-pinned)**, **wasmtime v45.0.0**, and
**Node.js / V8** — to establish whether the cliff is wasmtime-specific or general
WasmGC.

## The repro (committed under `bench/`)

- `bench/gc-array-copy.wat` — minimal module: an i8 GC array `(array (mut i8))`,
  exports `alloc(N)` + three internally-rounded benches (`bench_arraycopy`,
  `bench_elemloop`, `bench_memcopy`) and self-contained `run_*(N, rounds)`
  drivers (alloc + loop) so a single `wasmtime --invoke` does everything.
- `bench/run-node.mjs` — assembles the `.wat` (via the `binaryen` dep) and times
  each path under Node/V8. `node bench/run-node.mjs [N] [rounds]`.
- `bench/run-wasmtime.mjs` — assembles the `.wat` (via `binaryen`) then drives
  the resulting `.wasm` under a given wasmtime (difference-of-two-round-counts to
  cancel startup/compile/alloc; memory.copy measured absolutely).
  `node bench/run-wasmtime.mjs /path/to/wasmtime [N]`.

Note: `wasm-tools`/`wat2wasm` aren't in this container, so both harnesses assemble
via the `binaryen` dep (which parses the GC text format) — the compiled `.wasm` is
a gitignored build artifact, not committed. With a GC-capable `wasm-tools`/
`wat2wasm` you can pre-assemble `bench/gc-array-copy.wasm` instead.

## Results (measured 2026-06-05, N = 16 MiB)

| copy path | wasmtime v44.0.2 | wasmtime v45.0.0 | Node/V8 (25.x) |
|---|---:|---:|---:|
| **`array.copy`** (i8 GC) | **7 MiB/s** | **8 MiB/s** | **17,513 MiB/s** |
| `elem-loop` (GC get/set) | 214 MiB/s | 244 MiB/s | 1,221 MiB/s |
| `memory.copy` (linear) | 23,567 MiB/s | 23,812 MiB/s | 24,719 MiB/s |

### Conclusion

- **The `array.copy` cliff is wasmtime-specific.** wasmtime's i8 `array.copy`
  runs at **~7–8 MiB/s** — about **30× slower than even a naive element loop in
  the same runtime**, and **~2,200× slower than V8's `array.copy`** (17.5 GiB/s).
  V8's native bulk op is fast and competitive with its own `memory.copy`, exactly
  as expected; wasmtime has a pathological slow path for i8 `array.copy`.
- **Linear `memory.copy` is fast and consistent everywhere** (~24 GiB/s on all
  three) — confirming #1886's strategy of routing provably-I/O-only `Uint8Array`
  buffers to linear memory, and validating the host's element-loop workaround
  (#1863) as the right call *for wasmtime*.
- Secondary: wasmtime's GC element-loop (~214–244 MiB/s) is also ~5× slower than
  V8's (~1,221) — general WasmGC immaturity in wasmtime — but `array.copy` is the
  egregious outlier worth escalating.
- v44→v45 did not move `array.copy` materially.

## Remaining follow-up (gated on sign-off)

File an **upstream wasmtime issue**: i8 GC `array.copy` is ~30× slower than an
element loop and ~2,200× slower than V8, on the minimal `.wat` here. Do NOT open
the upstream issue without sign-off (per project policy on external issues);
reuse the `.tmp/wasmtime-gc-bug/` scratch notes.

## Notes / prior art

- #1863 records the original measurement and the host's element-loop workaround.
- #1886 (linear-backed `Uint8Array`) is the compiler-side fix that routes I/O
  buffers to `memory.copy`/zero-copy and sidesteps GC `array.copy` entirely.

## Reconciliation — DONE (2026-07-03)

The investigation deliverable was landed by **PR #1220**
(`docs(#1895): minimal .wat GC array.copy vs linear memory.copy benchmark`,
merged 2026-06-05, branch `issue-1895-gc-copy-bench`). Verified on `main`:

- The committed repro exists under `bench/`: `bench/gc-array-copy.wat`
  (i8 GC array with `bench_arraycopy` / `bench_elemloop` / `bench_memcopy`),
  `bench/run-node.mjs`, and `bench/run-wasmtime.mjs`.
- The issue body itself carries the `## Results (measured 2026-06-05, N = 16 MiB)`
  section — the throughput findings this investigation set out to capture.

Both the artifact and the measured results are recorded, so the investigation
is complete. Flipped during the 2026-07-03 stale-backlog reconciliation.
