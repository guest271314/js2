---
id: 1530
title: "wasi: Native Messaging host example (Chrome extension integration)"
status: done
created: 2026-05-20
updated: 2026-05-24
completed: 2026-05-24
priority: medium
feasibility: medium
reasoning_effort: low
task_type: example
area: wasi, runtime, docs
language_feature: stdin, stdout, process.env
goal: wasi-completeness
sprint: 55
github_issue: 389
filed_by: guest271314
related: [1482, 1483, 1484]
---
## Problem

Chrome's Native Messaging protocol lets extensions communicate with a
compiled binary by piping JSON messages over stdin/stdout using a 4-byte
little-endian length prefix. This is a direct and practical use-case for
`--target wasi` output: compile a TypeScript messaging host to `.wasm`,
run it under `wasmtime`/`wasmer`, and wire Chrome to the runner via the
native host manifest.

Comparable runtimes already have examples:
- AssemblyScript: [`nm_assemblyscript.ts`](https://github.com/guest271314/native-messaging-webassembly/blob/main/nm_assemblyscript.ts)
- Javy: [`nm_javy.js`](https://github.com/guest271314/native-messaging-webassembly/blob/main/nm_javy.js)
- qjs-wasi.wasm: [`nm_qjs_wasi.js`](https://github.com/guest271314/native-messaging-webassembly/blob/main/nm_qjs_wasi.js)

js2wasm has no equivalent example. The blocker is that stdin reading (#1481)
and stderr routing (#1480) are not yet implemented. Once those land this
becomes a documentation + example task with minimal compiler work.

## Expected output

A working `examples/native-messaging/` directory containing:

```
examples/native-messaging/
  host.ts          ← the TypeScript source compiled by js2wasm
  README.md        ← build + install instructions
  manifest.json    ← Chrome native host manifest template
  run.sh           ← wasmtime/wasmer wrapper script (Chrome calls this)
```

### `host.ts` sketch

```typescript
// Native Messaging protocol: 4-byte LE length prefix + UTF-8 JSON body
function readMessage(): unknown {
  const lenBytes = readStdin();          // #1481: reads 4 bytes from fd=0
  const len = new DataView(...)....;    // decode LE uint32
  const payload = readStdin(len);       // read len bytes
  return JSON.parse(payload);
}

function writeMessage(msg: unknown): void {
  const body = JSON.stringify(msg);
  const len = body.length;
  // write 4-byte LE prefix then body to stdout (fd=1)
  process.stdout.write(new Uint8Array([len & 0xff, (len >> 8) & 0xff,
                                       (len >> 16) & 0xff, (len >> 24) & 0xff]));
  process.stdout.write(body);
}

// Main loop
while (true) {
  const msg = readMessage();
  // echo back with a wrapper — replace with real application logic
  writeMessage({ received: msg, runtime: "js2wasm+wasi" });
}
```

### `manifest.json` (template)

```json
{
  "name": "com.example.js2wasm_host",
  "description": "js2wasm Native Messaging host",
  "path": "/path/to/run.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]
}
```

### `run.sh`

```sh
#!/bin/sh
exec wasmtime /path/to/host.wasm
```

### Build command

```sh
npx js2wasm host.ts --target wasi -o host.wasm
```

## Dependencies (blockers)

| Issue | Title | Status |
|-------|-------|--------|
| #1481 | WASI: stdin fd_read (`readStdin()`) | in-progress |
| #1480 | WASI: console.error/warn → fd=2 (stderr) | in-progress |

Stdout is already fd=1 via the existing `__wasi_write_string` helper.
Stderr routing (#1480) is needed so debug `console.error()` calls inside
the host don't corrupt the protocol stream on stdout. Stdin (#1481) is
the hard blocker — without `fd_read` the message loop cannot read.

## Nice-to-have (non-blocking)

- #1482 (environ_get) — lets the host read env vars for config
- #1483 (clock_time_get) — lets the host timestamp responses
- #1484 (poll_oneoff) — already done; not needed for sync message loop

## Acceptance criteria

- `host.ts` compiles with `npx js2wasm host.ts --target wasi` without errors
- `echo -e '\x0c\x00\x00\x00{"ping":true}' | wasmtime host.wasm` echoes back
  a 4-byte-prefixed JSON response
- `README.md` covers: build, manifest install on Linux/macOS/Windows,
  Chrome registration steps, testing with `webext-run` or manual load
- No compiler changes needed beyond what #1480 and #1481 provide

## Scope note

This is a **platform example + integration guide**, not a compiler feature.
The only compiler work is verifying the existing WASI target emits a binary
that the wasmtime/wasmer runner can host under Chrome's native messaging
constraints (no network, no filesystem beyond the binary path, stdin/stdout
only). If any compiler adjustments are needed they should be filed as child
issues.

## Implementation (2026-05-24, dev-1530)

Delivered `examples/native-messaging/`:
- `host.ts` — reads the framed message from stdin (`readStdin()`), decodes the
  4-byte LE length prefix, routes debug to stderr (`console.error`), emits a
  JSON response on stdout (`console.log`).
- `README.md` — build/run/Chrome-wiring walkthrough, **honest "what works /
  what doesn't" table**, per-platform manifest install (Linux/macOS/Windows).
- `manifest.json` — Chrome native-host manifest template.
- `run.sh` — wasmtime/wasmer wrapper (absolute-path-resolving), executable.
- `.gitignore` — ignores `examples/native-messaging/out/` build output.
- `tests/issue-1530.test.ts` — pins compile + WASI-module-validity of the
  example (3 tests, passing).

## Test Results

- `host.ts` compiles under `--target wasi`: **OK** (6479 bytes, validates as a
  WebAssembly module, imports only `wasi_snapshot_preview1` — `fd_read` +
  `fd_write`, no `env.*`).
- CLI build (`npx tsx src/cli.ts host.ts --target wasi -o out`): **OK**.
- `tests/issue-1530.test.ts`: **3/3 passing**.
- `buildWasiPolyfill()` round-trip with a framed `{"ping":true}` message: the
  host **reads stdin and decodes the length correctly** (decoded body length 13
  matches), but the **stdout response is corrupted** (see findings).

## Findings — two honest blockers for a *production* Chrome host

The message **read + decode + process** path works today. The **response
framing** does not, for two distinct compiler reasons (both filed):

1. **No raw-byte stdout primitive** → cannot emit the binary 4-byte LE length
   prefix. `console.log` UTF-8-encodes and appends `\n`. Filed as
   **#1617** (wasi: `writeStdout(bytes)` builtin).
2. **`console.log` of a runtime string emits a corrupted `[object]`
   placeholder** under `--target wasi` (only string literals + numbers print
   cleanly). So even the JSON *body* can't be written from a computed string.
   Filed as **#1618** (high priority — it's a plain codegen bug in
   `emitWasiValueToStdout`).

Acceptance criterion "echoes back a 4-byte-prefixed JSON response" is therefore
**not met** with the current compiler — documented honestly in the example
README, same approach as #1590's wasmtime-not-installed handling. The example
is a working stdin reader + integration guide; it becomes a drop-in Chrome host
once #1617 and #1618 land.

## Follow-up issues filed

- **#1617** — `plan/issues/1628-wasi-raw-byte-stdout.md` (raw-byte stdout)
- **#1618** — `plan/issues/1618-wasi-runtime-string-stdout-corrupt.md` (runtime-string corruption bug)
