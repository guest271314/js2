---
id: 1617
title: "wasi: raw-byte stdout primitive (writeStdout(bytes)) for binary protocols"
status: backlog
created: 2026-05-24
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: wasi, codegen, runtime
language_feature: stdout
goal: wasi-completeness
related: [1530, 1480, 1481]
parent: 1530
---

## Problem

The WASI stdout path only writes UTF-8-encoded strings via `console.log`,
which also appends a trailing `\n`. There is no way to write **arbitrary bytes**
(including NUL / high bytes) verbatim to fd=1.

This blocks binary framing protocols. The motivating case is Chrome Native
Messaging (#1530): each message must be prefixed with a **4-byte little-endian
`uint32` length**, written as raw bytes on stdout. `console.log` cannot express
this — it UTF-8-encodes its argument and appends a newline, so a length prefix
like `\x0d\x00\x00\x00` is impossible to emit cleanly.

## Proposal

Add a `writeStdout(bytes: Uint8Array)` builtin (and likely `writeStderr`)
under `--target wasi`, lowering directly to `fd_write(1, iov, 1, nwritten)`
over the bytes' linear-memory backing, with **no newline and no UTF-8
re-encoding**. This mirrors the existing `readStdin()` builtin (#1481) on the
write side.

Reference helper already in tree: `emitWasiWriteStringHelper` in
`src/codegen/index.ts` writes a ptr/len pair to fd=1 — a byte-buffer variant
would feed it the Uint8Array's memory offset and length directly.

## Acceptance criteria

- `writeStdout(new Uint8Array([0x0d, 0x00, 0x00, 0x00]))` emits exactly those
  four bytes on fd=1, no newline.
- The #1530 host can frame a response (length prefix + JSON body) correctly.
- Round-trips through `buildWasiPolyfill()` in a unit test.

## Origin

Filed from #1530 (Native Messaging host example), which documents this as the
hard blocker for a production Chrome host.
