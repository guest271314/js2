---
id: 1653
title: "wasi: process.stdin.read(buffer, offset?) — binary incremental stdin read into a typed buffer"
status: backlog
created: 2026-05-24
updated: 2026-05-24
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: wasi, codegen, runtime
language_feature: stdin, process, arraybuffer
goal: wasi-completeness
sprint: Backlog
depends_on: [1654]
related: [1530, 1481, 1651, 1654]
---

## Problem

The AssemblyScript reference host
([`nm_assemblyscript.ts`](https://github.com/guest271314/native-messaging-webassembly/blob/main/nm_assemblyscript.ts))
reads the Native Messaging stream in two precise steps inside a long-lived
`while (true)` port loop:

1. Read the **4-byte LE length header** — exactly 4 bytes.
2. Read **exactly N body bytes** — where N is decoded from the header.

It does this via `process.stdin.read(arrayBuffer)` /
`process.stdin.read(buffer, offset)`, which **returns the number of bytes
read** and fills a caller-supplied typed buffer.

js2wasm only has `readStdin()` (#1481). That builtin:

- **drains fd=0 to EOF** — it cannot read a fixed byte count;
- **cannot read incrementally** — once it hits EOF the loop is over, so a
  continuous request/response port loop is impossible;
- **returns a STRING** — UTF-8 decoded, so binary fidelity is lost (the
  4-byte LE header and any binary body get mangled).

This means js2wasm can neither read a framed message the way the reference
does, nor sustain the reference's continuous-loop design.

## Proposed implementation

Add a `process.stdin.read` builtin, recognised under `--target wasi`:

```typescript
process.stdin.read(buf: ArrayBuffer | Uint8Array, offset?: number): number
```

- Lowers to `fd_read(0, iov, 1, nread)` where the single `iov` points at the
  backing bytes of `buf` starting at `offset` (default 0), with `iov.len`
  equal to the remaining writable capacity of `buf` from `offset`.
- Returns `nread` (bytes actually read), so the caller can loop until it has
  the exact count it needs — matching the AssemblyScript reference's
  read-header-then-read-body pattern.
- Reads are incremental: each call advances fd=0's cursor, so a
  `while (true)` port loop can read header + body, respond, and read again.

This is the **keystone** issue: it unlocks BOTH the reference's read side
*and* its continuous-loop design. With only `readStdin()` neither is
expressible.

## Dependencies

Depends on **#1654** — the buffer this builtin reads into is an
`ArrayBuffer`/typed buffer, which currently produces an **invalid wasm
module under `--target wasi`** (the dual-mode heap/memory-global gap). The
backing-buffer story must work standalone first, or be co-designed with
this issue. Without a valid standalone `ArrayBuffer`, there is nowhere for
`fd_read` to write the bytes.

## Acceptance criteria

- `process.stdin.read(buf, offset?)` compiles under `--target wasi` and
  produces a module wasmtime accepts.
- Reading the 4-byte LE header: a call with a 4-byte buffer returns `4` and
  the buffer holds the exact header bytes (no UTF-8 mangling).
- Reading the body: a subsequent call with an N-byte buffer returns the body
  bytes verbatim.
- A `while (true)` loop reading header then body, framing a response, and
  reading again works for at least two consecutive messages under wasmtime.
- The Native Messaging host (`examples/native-messaging/host.ts`) can adopt
  the binary read path (the string-based `readStdin()` workaround can be
  retired once this + #1654 + #1655 land — tracked in #1530).
