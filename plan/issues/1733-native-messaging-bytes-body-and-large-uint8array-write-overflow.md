---
id: 1733
title: "Native Messaging host: 1 MiB body corruption — byte-write helpers miss the memory-grow guard; refactor host to raw-Uint8Array 3-symbol API"
status: done
created: 2026-05-29
updated: 2026-05-29
completed: 2026-05-29
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, runtime, docs
language_feature: wasi, stdout-write, uint8array, arraybuffer
goal: real-world-compat, wasi-completeness
sprint: 57
parent: 389
related: [389, 887, 1530, 1651, 1655, 1723]
reporter: guest271314
---
# #1733 — Native Messaging 1 MiB body corruption + raw-byte API refactor

## Problem

Reported by guest271314 against the Native Messaging host (parent #389), tested
in WASI/standalone mode. A small framed message round-trips fine, but a **1 MiB**
framed message comes back corrupt:

```
declared body length 1048576
message: [null, null, … 209615+ items]
```

#1723 already fixed the **string-write** path for large responses (ConsString
downcast + `__wasi_write_any_string` memory-grow guard). This issue covers the
remaining gap on the **raw-byte** write path, plus a host-source refactor that
removes the lossy string round-trip entirely.

## Root cause

`ensureWasiWriteUint8ArrayHelper` and `ensureWasiWriteArrayBufferHelper`
(`src/codegen/index.ts`) stage the body bytes into linear memory at
`WASI_WRITE_SCRATCH_START` (128 KiB, page 2), one byte at a time, then issue a
single `fd_write`. The module reserves only **3 pages (192 KiB)** by default, so
a ~1 MiB `process.stdout.write(Uint8Array)` writes far past the end of memory.

The string-write helper got the memory-grow guard in #1723
(`neededPages = ceil((SCRATCH_START + len) / 65536); if (neededPages >
memory.size) memory.grow(...)`), but these two **byte-write siblings were
missed** — so a large raw-byte write traps `memory access out of bounds` (or,
under a bump allocator that reuses memory, silently corrupts the output, which
is what produced guest's `[null, …]`).

Reproduced directly: a minimal `main()` that builds a 1 MiB `Uint8Array` and
calls `process.stdout.write(buf)`, compiled `--target wasi`, traps
`memory access out of bounds`. After the fix it writes 1,048,576 byte-exact
bytes.

## Fix

1. **`ensureWasiWriteUint8ArrayHelper` + `ensureWasiWriteArrayBufferHelper`
   (`src/codegen/index.ts`)** — add the same `memory.grow` guard the
   string-write helper has (#1723): compute `neededPages` from
   `WASI_WRITE_SCRATCH_START + len` and grow linear memory before staging. Adds
   one `needPages` i32 local to each helper.

2. **`examples/native-messaging/host.ts`** — refactor to the **3-symbol API**
   the reference hosts (`nm_assemblyscript.ts`, `nm_javy.js`, `nm_qjs_wasi.js`)
   use across runtimes:
   - `getMessage()` — read the 4-byte LE header then exactly N body bytes,
     return the body as a raw **`Uint8Array`** (empty buffer = EOF / truncated
     frame). The body is **never** decoded to a JS string, so it round-trips
     byte-exactly at any size and avoids building a million-node ConsString rope.
   - `sendMessage(message)` — frame a `Uint8Array` body: LE length prefix +
     raw body bytes to stdout, no trailing newline.
   - `main()` — the port loop: `const m = getMessage(); sendMessage(m);` until
     an empty body. Strict verbatim echo preserved (#930). Carrying bytes is
     also forward-compatible with Chromium's in-progress `Uint8Array` Native
     Messaging support.

3. **`examples/native-messaging/README.md`** — document the 3-symbol API and add
   a section explaining `out/host.imports.js` (the generated WASI/JS-host imports
   glue; not used by the standalone WASI launch path, emitted for the JS-host
   on-ramp).

## Tests

`tests/issue-1530.test.ts`:
- `echoes a 1 MiB framed body byte-exactly (#389 large-message regression)` —
  drives the shipped example through the raw-byte WASI shim with a 1 MiB body
  (0..250 byte ramp), asserts the 4-byte LE prefix declares 1 MiB and the
  response body is byte-identical.
- `writes a 1 MiB Uint8Array to stdout without trapping` — minimal compiler-side
  regression: a large `process.stdout.write(Uint8Array)` no longer traps.

The pre-existing #1530 compile/validity tests and the 13-byte round-trip test
stay green; the smoke-test (`smoke-test.sh`) stderr/stdout assertions are
unchanged (`getMessage()` keeps the exact `[host] received 17 chars, declared
body length 13` debug line).

## Result

Fixed. Native Messaging host round-trips byte-exactly for 13 B, 1 KiB, 64 KiB,
256 KiB, and 1 MiB bodies; the body is carried as raw bytes end-to-end with no
lossy stringify.
