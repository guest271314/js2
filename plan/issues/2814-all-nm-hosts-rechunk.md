---
id: 2814
title: All Native-Messaging example hosts must re-chunk (≤1 MiB JSON frames)
status: done
sprint: 69
priority: medium
area: examples
related: [389, 2807, 2810, 2775]
assignee: ttraenkler/agent-a089c35fb80d8f342
completed: 2026-06-29
---

# All Native-Messaging example hosts re-chunk consistently

## Problem

The four `examples/native-messaging/` host variants compiled to standalone WASI
should all behave the same on the WRITE side: accept a large (64 MiB+) framed
input and stream the response back as a sequence of **valid `≤1 MiB` JSON
frames** — the real Chrome native-messaging host→extension cap (a host literally
cannot send more than 1 MB per message). Before this issue only
`nm_js2wasm_node_fs` and `nm_js2wasm_node_process` re-chunked; `nm_js2wasm_deno`
and `nm_js2wasm_wasi_p1` were VERBATIM echoers (they streamed the whole 64 MiB
back in one logical message), which the loopdive/js2#389 reporter flagged as a
break from the intended design.

Per the maintainer, re-chunking (64 MiB in, ≤1 MiB JSON frames back) is **NOT
optional** — the examples should behave consistently where they can, and no
verbatim hosts should remain.

## Change

- **`nm_js2wasm_deno.ts`** — uses the shared `nm_js2wasm_sync_framing` core; now
  passes a 1 MiB re-chunk cap (a LOCAL const, mirroring `nm_js2wasm_node_fs`'s
  `frameChunk`) to `runNmHost` instead of `0` (verbatim). Bodies > 1 MiB split
  into valid `[run]`/`"run"` frames; ≤1 MiB bodies echo verbatim.
- **`nm_js2wasm_wasi_p1.ts`** — does NOT use the shared core (raw
  `wasi_snapshot_preview1` `fd_read`/`fd_write` over `wasm:memory` linear-memory
  accessors). Added a linear-memory re-chunker mirroring the shared core: peek the
  first body byte (`"` → `"run"` string frames; else `[run]` array frames split at
  comma boundaries), streamed through two fixed work buffers. Keeps the raw
  linear-memory IO (its demo value); only the OUTPUT is bounded. Because the
  raw-WASI module owns a FIXED 3-page (192 KiB) linear memory and `wasm:memory`
  exposes no `memory.grow`, its frame cap is **64 KiB** (comfortably ≤ the 1 MiB
  browser cap — a host may always send smaller frames). The two node hosts cap at
  1 MiB.
- **Tests / scale**:
  - `examples/native-messaging/scale-test.mjs`: `nm_js2wasm_deno` and
    `nm_js2wasm_wasi_p1` set to `mode: "rechunk"`; header + final message updated.
  - `tests/native-messaging-matrix.test.ts`: the verbatim describe for deno +
    wasi_p1 replaced with the re-chunk round-trip check (now covers deno, wasi_p1,
    node_fs); the node_process describe converted from byte-identical to the same
    round-trip check (it had been silently failing at 64/128 MiB since #2810
    re-chunked its writes but this file's assertion was not updated).
  - `tests/native-messaging-comparison.test.ts`: the 1 MiB + 3 MiB "verbatim"
    large-payload cases converted to re-chunk round-trip checks.
  - `tests/issue-2657-raw-wasi-fd-import.test.ts`: the ">64 KiB streams through the
    fixed window" verbatim case converted to a re-chunk round-trip check.
  - `tests/issue-2684-deno-stdio.test.ts`: the deno-example case now compiles via
    `compileProject` (the example imports the shared core, so single-file `compile`
    left `runNmHost` as an unsatisfiable `env.*` host import — a pre-existing bug
    masked because the wasmtime describe is skipped where wasmtime is absent).

## Acceptance

All four hosts re-chunk 1 / 64 / 128 / 256 MiB: every output frame body ≤ 1 MiB,
reassembled interiors == input. No host echoes a single > 1 MiB frame.

## Verification

- In-process fd-shim + real wasmtime v46 round-trips at 1/64/128/256 MiB for all
  four hosts (array + string bodies): every frame ≤ 1 MiB, reassemble == input.
- `tests/native-messaging-matrix.test.ts`, `native-messaging-comparison.test.ts`,
  `issue-2657-raw-wasi-fd-import.test.ts`, `issue-2684-deno-stdio.test.ts`,
  `issue-2748-deno-transpile.test.ts`, `issue-2754-transpiled-nm-roundtrip.test.ts`
  all pass.
