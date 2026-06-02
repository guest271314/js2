---
id: 1651
title: "wasi: process.stdout.write(str|Uint8Array) → fd_write (no newline, raw bytes)"
status: done
created: 2026-05-24
updated: 2026-05-24
completed: 2026-05-24
priority: high
feasibility: medium
reasoning_effort: medium
task_type: feature
area: wasi, codegen
language_feature: stdout, process
goal: wasi-completeness
sprint: Backlog
related: [1530, 1617, 1618]
supersedes: 1617
---
## Problem

`console.log` in WASI mode always appends a newline and UTF-8-encodes its argument.
There is no way to write a string without a trailing newline, or to write raw bytes
verbatim to fd=1 (e.g. the binary 4-byte LE length prefix in Chrome Native Messaging).

The natural Node.js API for both is `process.stdout.write`:
```typescript
process.stdout.write("hello")                        // no newline
process.stdout.write(new Uint8Array([13, 0, 0, 0]))  // raw bytes
```

## Proposed implementation

In `src/codegen/expressions/calls.ts`, detect `process.stdout.write(arg)` and
`process.stderr.write(arg)` (for fd=2) in WASI mode:

- **string arg**: encode to UTF-8 bytes (or extract from NativeString data array),
  write via `fd_write(fd, iov, 1, nwritten)` — no trailing newline appended
- **Uint8Array arg**: copy GC array elements to linear memory scratch, write via
  `fd_write(fd, iov, 1, nwritten)` — raw bytes, no transformation

## Acceptance criteria

- `process.stdout.write("hello")` emits `hello` with no newline under wasmtime
- `process.stdout.write(new Uint8Array([0x0d, 0x00, 0x00, 0x00]))` emits exactly 4 bytes
- The Native Messaging host (`examples/native-messaging/host.ts`) frames a response
  correctly: 4-byte LE prefix + JSON body on stdout
- `buildWasiPolyfill()` round-trip test passes
- `process.stderr.write` routes to fd=2 (same pattern as console.error)

## Supersedes

#1617 (`writeStdout` custom builtin) — `process.stdout.write` is the standard Node.js
API and avoids adding a bespoke builtin. #1617 is closed in favour of this issue.

## Implementation notes (resolution)

- **Detection** (`src/codegen/expressions/calls.ts`): `matchProcessStdStreamWrite`
  matches the exact shape `process.stdout|stderr.write(arg)` (one arg, no
  optional-chaining, `process` not shadowed by a local/capture), gated on
  `ctx.wasi` + an `fd_write` import. `registerWasiImports` was extended to set
  `needsFdWrite` (and `needsConsoleStderr` for the stderr stream) when this
  callee shape appears, so the imports/helpers are present.
- **String arg**: routes through the same `__wasi_write_any_string` helper as
  the #1618 `console.log` fix (`ensureWasiWriteAnyStringHelper`) — flatten +
  per-code-unit byte copy + one `fd_write`, no trailing newline.
- **Uint8Array arg**: `ensureWasiWriteUint8ArrayHelper` (new, in
  `src/codegen/index.ts`) reads the Uint8Array's `vec` struct (field 0 = length,
  field 1 = `array<f64>` data), truncates each element to a byte into the
  page-2 write-scratch region, and issues one `fd_write` — raw bytes verbatim,
  no transform, no newline. Works for the literal-array case the Native
  Messaging length prefix needs.
- **stderr**: `useStderr` swaps fd=1→fd=2 and selects the stderr helper variant.

The host (`examples/native-messaging/host.ts`) now frames its response with
`process.stdout.write(new Uint8Array([...4-byte LE...]))` + `process.stdout.write(body)`,
mirroring the Node.js API of the AssemblyScript reference. Byte-exact round-trip
covered by `tests/issue-1530.test.ts`; per-API behaviour by
`tests/issue-1618-1651-wasi-stdout.test.ts`.

Landed on main in PR #573 / commit `17fee538b`.
