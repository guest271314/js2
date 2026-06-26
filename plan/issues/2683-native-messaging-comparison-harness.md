---
id: 2683
title: "Native Messaging: node:process async-stream variant + 5-way comparison harness (README table + cross-variant byte-identical test)"
status: done
assignee: ttraenkler/agent-ada80d
completed: 2026-06-26
created: 2026-06-26
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: example
area: examples
es_edition: multi
language_feature: wasi, process.stdin, native-messaging
goal: dogfood
related: [389, 2655, 2657, 2632]
sprint: 66
---

# #2683 — Native Messaging node:process variant + 5-way comparison harness

`examples/native-messaging/` collects the **same** Native Messaging echo host
(read a 4-byte little-endian length prefix + body off fd 0, write the framed
response to fd 1) implemented against several host surfaces so they can be
compared. Two variants already existed (`nm_wasi.ts` raw WASI P1 #2657,
`nm_js2wasm.ts` synchronous `node:fs` #2655). This issue adds the **`node:process`
async-stream variant** and the **comparison harness** that ties the family
together.

## Deliverables

1. **`examples/native-messaging/nm_node_process.ts`** — the host built on the
   faithful Node streaming stdio surface: the `process.stdin` Readable (#2632,
   `src/process-stdin-prelude.ts`) for the event-driven read side, and
   `process.stdout.write` for the write side. Because `process.stdin` is async,
   the framed protocol is parsed incrementally: buffer `'data'` chunks, and echo
   each complete frame (prefix + body) as it arrives. Compiles under
   `--target wasi` (imports only `wasi_snapshot_preview1`) and runs under
   wasmtime with a byte-correct framed echo.

2. **`examples/native-messaging/README.md`** — a 5-variant comparison **table**
   (one row per variant, all pre-filled descriptively even for the two that land
   separately): columns Host surface / Source import / Sync-or-async / Emitted
   wasm imports / Runs natively under / Compiles to, plus a prose intro framing
   the comparison (same protocol, different host API; the #389 "WASI not Node"
   context).

3. **`tests/native-messaging-comparison.test.ts`** — a cross-variant test that
   **discovers** every `nm_*.ts` on disk, compiles each under `--target wasi`,
   and (for those that lower to a standalone WASI command module) runs each with
   the same stdin frame asserting **byte-identical** framed-echo output.
   Synchronous variants run in-process under a raw fd shim (CI-safe, no external
   runtime); reactor-driven async variants run under real wasmtime when present
   (`findWasmtime()` gate). Non-standalone variants (e.g. the WASI P3 component
   spike, which needs its own runner) are skipped gracefully, so `nm_deno.ts` /
   `nm_wasi_p3.ts` are picked up with no edits when they land.

## Key findings

- **`process.stdin` requires the `process` global, not an import.** The
  `process.stdin` Readable prelude (`findStdinAccesses`) deliberately skips a
  user-declared/-imported `process` binding, so `import process from
"node:process"` would disable the injection. The variant references the global.
- **The framed response must be a `Uint8Array`, not a string.**
  `process.stdout.write(string)` UTF-8-encodes (via `ensureWasiWriteAnyStringHelper`),
  which corrupts the binary 4-byte length prefix and any high body byte; the
  `Uint8Array` overload writes raw bytes.
- **`main` must NOT be exported.** An exported no-arg `main` becomes the `_start`
  target _and_ is re-invoked by the top-level `main()` call captured in
  `__module_init` (`src/codegen/index.ts` ~L2074) — so it runs twice. A
  synchronous host masks the double-run (the second hits EOF), but this async
  host registers its stdin listeners in `main`, so a double-run echoed every
  frame twice (observed). Keeping `main` non-exported makes `_start` wrap
  `__module_init`, which calls `main()` exactly once.

## Validation

- `nm_node_process.ts` compiles under `--target wasi`, imports only
  `wasi_snapshot_preview1`, validates, and echoes a framed message byte-for-byte
  under real wasmtime (single- and multi-frame).
- `tests/native-messaging-comparison.test.ts` is green: all variants compile +
  validate, and the byte-identical echo holds across the standalone-WASI variants
  (synchronous ones in-process, `nm_node_process.ts` under wasmtime).
- Byte-neutral for the compiler (examples + a test only).
