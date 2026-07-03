---
id: 2775
title: "Native Messaging examples: rename to host scheme + 1/64/128 MiB CI matrix (shared sync-framing dedup deferred to #2771)"
status: done
assignee: ttraenkler/dev-2775-nm-refactor
completed: 2026-06-28
created: 2026-06-27
priority: medium
feasibility: medium
task_type: refactor
area: examples
goal: developer-experience
related: [389, 2655, 2657, 2684, 2752, 2776, 2771, 2777]
sprint: 69
---

# #2775 — Native Messaging examples: rename to host scheme + scale matrix

The `examples/native-messaging/` directory carries the SAME Native Messaging
echo host implemented against several host surfaces (loopdive/js2#389). The file
names had drifted from the host-surface scheme, and the multi-MiB scale tests
were CI-excluded. This issue (a) renames every variant to the host scheme, (b)
adds a 1/64/128 MiB CI matrix that runs on every CI run, and (c) records the
finding that the shared sync-framing dedup is BLOCKED on a compiler limitation
(deferred to #2771).

## Renames (history preserved via `git mv`)

| old               | new               | host surface                                  |
| ----------------- | ----------------- | --------------------------------------------- |
| `nm_js2wasm.ts`   | `nm_node_fs.ts`   | synchronous `node:fs` `readSync`/`writeSync`  |
| `nm_wasi.ts`      | `nm_wasi_p1.ts`   | raw `wasi_snapshot_preview1` fd_read/fd_write |
| `nm_js2wasm.json` | `nm_node_fs.json` | Chrome native-host manifest                   |
| `nm_js2wasm.sh`   | `nm_node_fs.sh`   | wasmtime launcher                             |

Kept as-is: `nm_deno.ts` (Deno stdio), `nm_node_process.ts` (async
`process.stdin` reactor), `nm_wasi_p3.ts` (WASI Preview 3 source-reference).
Every reference (README, manifest, NODE-FS-SHIM.md, the cross-referencing
examples, `p3-b0-spike/README.md`, and all `tests/*.ts` that load these files by
path) was updated.

## 1 / 64 / 128 MiB CI matrix (`tests/native-messaging-matrix.test.ts`)

Runs on EVERY CI run (no `it.skip`), in its own file so the multi-MiB buffers do
not bloat the equivalence shards. Synchronous variants run under an in-process
raw-fd shim with BULK `Uint8Array` copies, so 128 MiB completes in seconds with
no external runtime.

- `nm_deno` + `nm_wasi_p1` (verbatim streamers) — byte-EXACT echo at 1/64/128 MiB.
- `nm_node_fs` (re-chunks bodies > 1 MiB into valid <=1 MiB JSON frames, by
  design) — ROUND-TRIP correctness at 1/64/128 MiB: every emitted frame is a
  valid `[…]` within the 1 MiB cap, and concatenating the frame interiors
  reconstructs the original array body byte-for-byte.
- `nm_node_process` — exercised only at a small size it handles today (under real
  wasmtime, reactor-driven); its large cases are GATED ON #2777 (the O(n^2)
  prelude fix). Not silently skipped — a clear pointer is logged when wasmtime is
  unavailable.

## Shared sync-framing dedup — BLOCKED, deferred to #2771

The original plan factored the framing/streaming core shared by `nm_deno` and
`nm_node_fs` into `nm_sync_framing.ts`, injected per host over a small
`NmHostIo { read; write }` seam. The dedup itself is clean, but the shared LOCAL
import cannot lower to a clean standalone WASI module under either compile path:

1. **Real CLI path = single-source `compile()`** (`src/cli.ts` reads ONE file and
   never bundles relative imports). `import { runEchoLoop } from
"./nm_sync_framing"` is unresolved → `runEchoLoop` lowers to a host import
   `env.runEchoLoop`, which the WASI strict-no-host-imports gate REJECTS. Breaks
   BOTH `nm_deno` and `nm_node_fs`.
2. **`compileProject()`** (the only path that bundles relative imports) DOES
   bundle the core, but the multi-file pipeline deliberately skips
   `detectNodeFsImports`/`preprocessImports` (`src/compiler.ts` ~L1338-1342:
   "`wasiNodeFsFuncs` stay undefined for multi mode"), so the `node:fs`->WASI
   `fd_read`/`fd_write` lowering never fires → `nm_node_fs` compiles to a module
   with ZERO fd IO. `nm_deno` survives this path only because `Deno.*` is an
   ambient global lowered independently.

So shared-file dedup is infeasible for CLI-compiled standalone examples until the
compiler gains EITHER relative-import bundling in the single-source/CLI path OR
`node:fs` lowering in the multi-file path. That compiler work is **#2771**
(senior-dev owned). This issue therefore keeps `nm_deno` + `nm_node_fs`
MONOLITHIC under their new names; the dedup + full byte-exact matrix re-apply on
top of #2771.

(One incidental fix kept regardless: naming the streaming-window parameter
`window` made WASI codegen reject it as the DOM global `window` — use a
non-global name.)

## Acceptance

- [x] All variants renamed to the host scheme via `git mv`; every reference updated.
- [x] `nm_deno`, `nm_node_fs`, `nm_wasi_p1` still compile to a clean standalone
      module importing ONLY `wasi_snapshot_preview1`.
- [x] 1/64/128 MiB matrix runs on every CI run (verbatim byte-exact for
      deno/wasi_p1; re-chunk round-trip for node_fs).
- [x] `nm_node_process` large cases gated on #2777 with a clear pointer; small
      size exercised.
- [x] Dedup blocker documented; deferred to #2771.
