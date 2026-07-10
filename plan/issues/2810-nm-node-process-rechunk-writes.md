---
id: 2810
title: "nm_js2wasm_node_process: re-chunk host->extension writes to the ≤1 MiB browser cap (like nm_js2wasm_node_fs)"
status: done
assignee: ttraenkler/agent-ad343
completed: 2026-06-28
created: 2026-06-28
updated: 2026-07-03
priority: medium
feasibility: medium
task_type: refactor
area: runtime
language_feature: native-messaging
goal: platform
sprint: 69
horizon: m
related: [389, 2807, 2775, 2778]
---

# nm_js2wasm_node_process: re-chunk writes to the ≤1 MiB browser cap

## Problem

`nm_js2wasm_node_process` (the async `process.stdin` reactor variant) was the
architectural outlier among the four Native-Messaging host examples: it
accumulated the WHOLE response frame and wrote it in ONE `process.stdout.write`,
whereas `nm_js2wasm_deno` / `nm_js2wasm_wasi_p1` stream through a 64 KiB window
and `nm_js2wasm_node_fs` re-chunks to ≤1 MiB. That single-big-write shape is why
it was the only host to hit wasmtime's ≥128 MiB single-`fd_write` cap (#2807).

Beyond consistency: a real Chrome Native-Messaging host is capped at **1 MB per
host→extension message**, so a >1 MB single response isn't even valid on that
surface — `nm_js2wasm_node_fs` re-chunks precisely for that cap.
`nm_js2wasm_node_process` should too, and re-chunking also **bounds resident
memory on the write side** (per-frame 1 MiB out buffers instead of one
full-size frame).

## Change

- `nm_js2wasm_node_process`'s echo now **re-chunks to ≤1 MiB JSON frames** on the
  WRITE side, matching `nm_js2wasm_node_fs`'s browser-cap re-chunk. A body within
  the cap is echoed verbatim (prefix + body) in one write; a body larger than the
  cap is split into a sequence of valid ≤1 MiB JSON frames whose interiors,
  concatenated by the receiver, reproduce the original body:
  - peek the first body byte — `"` → split the JSON string into `"run"` frames
    (fixed-run split); otherwise split the JSON array into `[run]` frames at comma
    boundaries (mirrors the final-batch drain of the shared
    `nm_js2wasm_sync_framing` re-chunker).
  - The faithful async `process.stdin` reactor on the READ side is unchanged; the
    whole frame body is already buffered by drain-time, so the re-chunk is a pure
    in-memory split (no streaming-read seam needed — the async path can't reuse
    the pull-based `runNmHost` core, so the emit/split logic is mirrored on the
    write side).
- Updated the #2807 scale coverage so `nm_js2wasm_node_process` is now a
  **re-chunk** variant (multiple ≤1 MiB frames), not a single byte-exact echo:
  - `examples/native-messaging/scale-test.mjs`: `nm_js2wasm_node_process` switched
    from `mode: "verbatim"` to `mode: "rechunk"` (driven with the `jsonArrayBody`
    payload, asserting every frame ≤1 MiB and reassembled == input — like
    `nm_js2wasm_node_fs`).
  - `tests/issue-2807-fd-write-cap.test.ts`: drives a >1 MiB JSON-array body and
    asserts re-chunk round-trip (every frame body ≤1 MiB; reassembled interiors ==
    input), plus a sub-1 MiB body that still echoes verbatim. The capped-`fd_write`
    guard from #2807 stays (no single fd_write exceeds `WASI_FD_WRITE_MAX_CHUNK`).

## Acceptance criteria

- `nm_js2wasm_node_process` re-chunks a 1 / 64 / 128 / 256 MiB JSON body into
  valid ≤1 MiB frames that reassemble byte-exact, under **real wasmtime v46**.
- The other three variants and the #2807 capped-`fd_write` guard still pass.

## Test Results

Validated 2026-06-28 in this worktree:

- In-process (compile → reactor shim): JSON **array** body 3 MiB → 4 frames, each
  body ≤1 MiB (max 1048571), reassemble == input; JSON **string** body 3 MiB → 4
  frames, each ≤1 MiB, reassemble == input; sub-1 MiB body echoes byte-exact.
- Real wasmtime v46.0.1 (`bun build --target node` → standalone `js2wasm` CLI →
  `wasmtime`), `jsonArrayBody`:
  - 1 MiB → 1 frame (1048576 ≤ cap), reassemble == input.
  - 64 MiB → 65 frames, max frame body 1048571 ≤ 1 MiB, reassemble == input.
  - 128 MiB → 129 frames (the original #2807 zero-output size) — re-chunks, all
    ≤1 MiB, reassemble == input.
  - 256 MiB → 257 frames, all ≤1 MiB, reassemble == input.

## Dependencies

- #2282 (rename `nm_*` → `nm_js2wasm_*`) — the file is
  `examples/native-messaging/nm_js2wasm_node_process.ts`.
- #2283 (#2807 `fd_write` cap fix) — adds `scale-test.mjs`,
  `tests/issue-2807-fd-write-cap.test.ts`, and the `WASI_FD_WRITE_MAX_CHUNK`
  export this issue extends.
