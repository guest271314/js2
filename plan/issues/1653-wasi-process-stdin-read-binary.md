---
id: 1653
title: "wasi: process.stdin.read(buffer, offset?) — binary incremental stdin read into a typed buffer"
status: done
created: 2026-05-24
updated: 2026-05-24
completed: 2026-05-24
priority: high
feasibility: hard
reasoning_effort: high
task_type: feature
area: wasi, codegen, runtime
language_feature: stdin, process, arraybuffer
goal: wasi-completeness
sprint: Backlog
depends_on: [1654]
required_by: [1530]
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

## Implementation notes (resolution)

`process.stdin.read(buf, offset?)` is recognised under `--target wasi` as a
standard-API builtin (no bespoke runtime function):

- **Detection** — `matchProcessStdinRead` in `calls.ts` matches the
  `process.stdin.read(...)` call shape (1-2 args, unshadowed `process`), mirror
  of `matchProcessStdStreamWrite`. A parallel AST scan in `index.ts` sets
  `needsFdRead` for the same shape so the `fd_read` import is registered even
  when `readStdin()` is never used.
- **Lowering** — `emitProcessStdinRead` (calls.ts):
  1. recover the buffer's vec struct + backing array (field 1) + element kind;
  2. `offset` → i32 (default 0); `capacity = buf.length - offset`;
  3. set iovec at memory[0]={buf=WASI_STDIN_BUF_START, len=capacity};
  4. `fd_read(0, 0, 1, 8)`; `nread = memory[8]`;
  5. copy `nread` bytes from the stdin scratch page into `backing[offset+j]`,
     converting per element kind (f64 vec for `Uint8Array`, i32_byte vec for
     `ArrayBuffer` — both made valid standalone by #1654);
  6. return `nread` as f64.

  Reads are incremental: each call issues one `fd_read`, so the fd=0 cursor
  advances and a `while (true)` port loop reads header then body then loops.
  The EventEmitter `.on('data')` streaming form is explicitly out of scope.

- **`readStdin()` deprecated** — kept working (back-compat) but annotated
  deprecated in `calls.ts` in favour of `process.stdin.read`, since it drains
  to EOF, UTF-8-decodes (binary loss), and can't sustain a continuous loop.

**Verified under real wasmtime** (`-W gc=y,function-references=y,tail-call=y,
exceptions=y`): a 4-byte-LE-header-then-body framed read round-trips ("HELLO"),
and a `while (true)` two-message echo loop (ArrayBuffer-backed header read)
emits both frames verbatim and terminates cleanly at EOF. Committed test
`tests/issue-1653-wasi-process-stdin-read.test.ts` pins compile + module
validity + binary-verbatim header/body + 2-message loop + non-zero-offset read
+ EOF=0 via the CI-portable raw-byte WASI shim. No regression: `readStdin()`
(`wasi-stdin.test.ts`) and the stdout suites all pass.
