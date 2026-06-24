---
id: 2639
title: "node:fs writeSync(fd, str | DataView) codegen — make the #2634 surface compilable"
status: done
created: 2026-06-24
updated: 2026-06-24
completed: 2026-06-24
assignee: ttraenkler/dev-2639
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bug
area: host-interop
language_feature: node-api-compat
goal: platform
sprint: 65
es_edition: n/a
related: [2631, 2633, 2634, 1772, 2624]
---

# node:fs writeSync(fd, str | DataView) codegen

## Problem

The #2634 capability map (`src/checker/node-capability-map.ts`,
`FS_WRITE_SYNC_DECLS`) declares TWO faithful `writeSync` overloads, mirroring
`@types/node`:

1. `writeSync(fd, buffer: __NodeFsArrayBufferView, offset?, length?, position?): number`
2. `writeSync(fd, str: string, position?, encoding?): number`

…and `__NodeFsArrayBufferView` includes `DataView`. So all of these
**type-check**. But the codegen arm (`src/codegen/node-fs-api.ts`,
`emitNodeFsWriteSync` + `emitNodeFsResolveGcU8`) only lowered the
Uint8Array / ArrayBuffer GC-`$Vec` case. As a result, on current main under
`--target wasi --link-node-shims`:

- `writeSync(1, "hello")` compiled to a **valid** module but wrote **ZERO
  bytes** — the GC-`$Vec` resolver returned `null` for a string arg, and the
  codegen emitted an `f64.const 0` byte count and silently dropped the value.
- `writeSync(1, new DataView(buf))` did the same — a `DataView` is part of
  `__NodeFsArrayBufferView` but is not a GC `$Vec` the resolver recognized.

Confirmed by linking the `node-fs` shim and capturing fd 1: both forms produced
an empty stream. The typings promise a surface the compiler couldn't honour.

## Approach

Stay import-scoped + provider-agnostic — the module still just declares
`import "node:fs" "writeSync"`; this is purely the codegen arm mapping a
string / DataView arg onto the pinned `writeSync(fd, ptr, len)` ABI
(`docs/architecture/node-fs-abi.md`). No new host import, no Node semantics
inlined.

- **String arm** (`writeSync(fd, str, position?, encoding?)`): encode the JS
  string to UTF-8 and write to the **runtime** `fd` via the shim. Reuses the
  exact WTF-16 → UTF-8 encoder that `process.std*.write(string)` already uses —
  factored out of `ensureWasiWriteAnyStringHelper` into a shared
  `buildWasiStringEncodeToScratch` (byte-identical, proven via a binary diff of
  the `process.std*.write` path), with a new fd-parameterized
  `ensureWasiWriteAnyStringFdHelper(s, fd) -> bytesWritten`. `encoding?` defaults
  to utf8 (the only byte form the native-string lowering produces); an explicit
  non-utf8 string-literal encoding is a clear **compile error**, not a silent
  mis-encode. `position?` is ignored for the fd-streaming case, exactly as the
  buffer overload ignores it for fd 0/1/2.
- **DataView arm**: resolve the DataView's backing `i32_byte` array + base
  byteOffset + byteLength to a `(ptr, len)` over the write scratch, mirroring the
  DataView accessors' `recoverDvBacking` (handles both the bare offset-0 view and
  the `$__dv_window` byteOffset/byteLength wrapper), then write that range. New
  exported helper `emitDataViewToWriteScratch` in `dataview-native.ts`.

## Acceptance

- [x] `writeSync(1, "hi\n")` + `writeSync(2, "err\n")` compile and emit the
      bytes to the right fd under `--target wasi` (linked node-fs shim),
      end-to-end.
- [x] Non-ASCII strings (multi-byte + astral `\u{1F600}`) and a runtime (rope)
      string encode as correct UTF-8 (byte count = UTF-8 length).
- [x] Explicit `"utf8"` / `"utf-8"` encoding accepted; an explicit non-utf8
      encoding (e.g. `"hex"`) is rejected with a clear diagnostic.
- [x] `writeSync(1, new DataView(buf))` writes the full backing range; a
      `new DataView(buf, byteOffset, byteLength)` windowed view writes only that
      range.
- [x] Existing Uint8Array / ArrayBuffer `writeSync` + `process.std*.write` paths
      unchanged (the `process.std*.write(string)` binary is byte-identical to
      main).
- [x] New wasmtime-style test over the linked shim for the string + DataView
      forms (`tests/issue-2639-node-fs-writesync-string-dataview.test.ts`, 8
      cases); tsc + biome lint clean.
- [x] Validated in batch (#1968): node-fs / wasi / dataview suites green (37
      pre-existing + 8 new), and a `runTest262File` DataView/String-concat
      control batch unchanged (the one pre-existing String.concat `this`-coercion
      fail and the pre-existing `process.argv` `it.fails` are unrelated to this
      change).

## Files

- `src/codegen/node-fs-api.ts` — string + DataView arms in `emitNodeFsWriteSync`
  (`emitNodeFsWriteSyncString`, `emitNodeFsWriteSyncDataView`).
- `src/codegen/index.ts` — extracted `buildWasiStringEncodeToScratch` (shared
  encoder) + new `ensureWasiWriteAnyStringFdHelper`.
- `src/codegen/dataview-native.ts` — exported `emitDataViewToWriteScratch`
  (reuses the existing private `recoverDvBacking`).
- `tests/issue-2639-node-fs-writesync-string-dataview.test.ts` — new tests.
