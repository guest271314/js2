---
id: 2832
title: nm_js2wasm_node_process READ side buffers the whole input frame (unbounded memory)
status: done
sprint: 69
priority: high
area: examples
language_feature: native-messaging
task_type: bug
related: [389, 2814, 2807]
assignee: ttraenkler/agent-dev
completed: 2026-06-29
---

# nm_js2wasm_node_process READ side is unbounded

## Problem (measured on 0.59.3)

`examples/native-messaging/nm_js2wasm_node_process.ts` round-trips correctly
under wasmtime but its **read side buffers the entire input frame** — peak RSS
scales ~**8x the frame size** (≈530 MB @ 64 MiB, ≈2 GB @ 256 MiB). The sibling
hosts (`nm_js2wasm_deno`, `nm_js2wasm_node_fs`, `nm_js2wasm_wasi_p1`) are
**flat/bounded** (16–27 MB regardless of frame size). #2814 re-chunked only the
WRITE side; the read side still accumulated the whole frame. This is exactly the
loopdive/js2#389 reporter's "node_process climbed to ~98% memory on a 64 MiB
frame" — the one remaining real bug among the four hosts.

### Root cause

The async `process.stdin` reactor delivers each `'data'` chunk bounded at one
64 KiB page (`RL_STDIN_BUF_CAP` in `src/codegen/async-scheduler.ts`). The old
host nevertheless `append`-ed every chunk into one growing `Uint8Array` and only
echoed a frame once the WHOLE body had arrived — `drain()` required
`tail - head >= 4 + len`. So a 64 MiB frame forced the read buffer to grow to
~64 MiB (amortized doubling overshoots further), and the >1 MiB re-chunk path
then read from that full-size buffer. The blow-up is entirely in the host `.ts`,
not the compiler.

## Goal

Make node_process's read side **bounded** like the other three: read/process
stdin in a fixed window and re-chunk to ≤1 MiB output frames WITHOUT holding the
whole input frame in memory at once. node_process uses the async
`process.stdin` reactor, so the fix is on the async read path — process each
chunk incrementally against a bounded buffer rather than concatenating the full
frame.

## Fix

Replace the buffer-everything `append`/`drain` with an **incremental state
machine** driven by the pushed `'data'` chunks. It mirrors the streaming
re-chunk logic of the shared `nm_js2wasm_sync_framing` core (`runRechunk`),
turned inside-out (push-driven instead of pull-driven):

- `ST_HEADER` — accumulate the 4-byte LE length prefix (across chunk
  boundaries); a declared length 0 is the in-band clean-shutdown frame
  (`process.stdin.destroy()`).
- `ST_VERBATIM` (body ≤ 1 MiB) — accumulate prefix+body into one per-frame
  buffer (≤ 1 MiB), emit in ONE `process.stdout.write`.
- `ST_PEEK` → `ST_ARRAY` / `ST_STRING` (body > 1 MiB) — stream the interior
  through a single reused 1 MiB window, emitting valid `[run]` (at comma
  boundaries) / `"run"` (fixed run) frames as the window fills; `ST_TRAILER`
  discards the closing `]`/`"`.

The only resident buffers are the fixed 1 MiB window, the per-output frame
buffer (≤ 1 MiB), and a per-frame verbatim buffer (≤ 1 MiB) — peak ≈ a couple of
MiB, flat across all frame sizes. Byte-exact echo/round-trip semantics and the
write-side re-chunk (#2814) / EOF+shutdown handling are preserved.

## Verify (acceptance bar — measure RSS)

- `node examples/native-messaging/scale-test.mjs` (NM_SCALE_SIZES_MIB="1 64 128
  256") — all four hosts still PASS byte-exact.
- Independently sample peak RSS (VmHWM) of the wasmtime process running the NEW
  node_process build at 64/128/256 MiB. **Acceptance: peak RSS is roughly flat /
  bounded — NOT ~8x the frame size** (tens of MB, like the other hosts).

## Test Results

`node examples/native-messaging/scale-test.mjs` (NM_SCALE_SIZES_MIB="1 64 128
256") — all four hosts PASS byte-exact (reassembled interiors == input, every
frame ≤ 1 MiB).

Peak RSS (VmHWM of the wasmtime process, array body, polled `/proc/<pid>/status`):

| frame  | OLD (origin/main) | NEW (#2832) |
| ------ | ----------------- | ----------- |
| 64 MiB | 530.5 MB          | 35.5 MB     |
| 128 MiB| 1042.5 MB         | 35.5 MB     |
| 256 MiB| 2066.5 MB         | 35.4 MB     |

OLD scales ~8x the frame size (reproduces the loopdive/js2#389 "~98% memory on a
64 MiB frame" report). NEW is flat/bounded (~35 MB) regardless of frame size,
the same order of magnitude as the sibling hosts (16–27 MB). Acceptance met.

### Codegen note (worked around in the host `.ts`, not a compiler change)

A module-scope `Uint8Array` read by element DIRECTLY inside a function (not the
one it was assigned in) miscompiles to a throwing null-guard, and passing such an
array through TWO function-parameter levels degrades it to an externref whose
element reads lower to an absent `__extern_get` host import. The streaming host
therefore (1) decodes the 4-byte prefix with a running number accumulator (no
header array), (2) only ever element-WRITES the module-global window in `onData`,
and (3) does every window READ inside a ONE-LEVEL helper that takes the window as
a parameter and copies inline. Filed mentally as a latent compiler gap; the
example stays within the supported surface by following this pattern.
