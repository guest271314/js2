---
id: 1628
title: "wasi: raw-byte stdout primitive (writeStdout(bytes)) for binary protocols"
status: wont-fix
created: 2026-05-24
updated: 2026-05-24
completed: 2026-05-24
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: wasi, codegen, runtime
language_feature: stdout
goal: wasi-completeness
sprint: Backlog
renumbered_from: 1617
parent: 1530
related: [1530, 1480, 1481]
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
hard blocker for a production Chrome host. (Originally numbered #1617; the
"#1617" references in the #1530 history refer to this issue, not the unrelated
codegen bug that now carries the literal `1617-*` slug.)

## Resolution — wont-fix (superseded by #1651)

**Closed as `wont-fix`.** Superseded by `process.stdout.write` (#1651), which is
the **standard Node.js API** and already shipped. `process.stdout.write(bytes)`
writes raw bytes verbatim to fd=1 (no newline, no UTF-8 re-encoding) and
`process.stdout.write(str)` writes a runtime string with no trailing newline —
covering everything this proposed `writeStdout(bytes)` builtin would have done.

A bespoke `writeStdout(bytes)` builtin is the **wrong shape** under the
project's no-bespoke-builtins direction: host capabilities are exposed as
standard Node.js APIs that guest TypeScript already knows (`process.stdout` /
`process.stdin`), never as invented intrinsics. guest271314's feedback on the
example ("I don't see an implementation of `readStdin`") is the motivating
signal — intrinsics aren't real APIs, so they have no Node reference and no
ecosystem familiarity. `process.stdout.write` is.

No action; do not implement. The binary-framing need this was filed for is met
by #1651 (already done) on the write side and #1653 (+#1654) on the read side.
