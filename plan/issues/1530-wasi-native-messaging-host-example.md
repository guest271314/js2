---
id: 1530
title: "wasi: Native Messaging host example (Chrome extension integration)"
status: done
created: 2026-05-20
updated: 2026-05-29
completed: 2026-05-29
priority: medium
feasibility: medium
reasoning_effort: low
task_type: example
area: wasi, runtime, docs
language_feature: stdin, stdout, process.env
goal: wasi-completeness
sprint: 55
depends_on: [1653, 1654]
github_issue: 389
filed_by: guest271314
related: [1482, 1483, 1484, 1651, 1653, 1654, 1655]
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

## Aligning with the AssemblyScript reference (follow-ups)

Full convergence on
[`nm_assemblyscript.ts`](https://github.com/guest271314/native-messaging-webassembly/blob/main/nm_assemblyscript.ts)
— the binary incremental stdin read, the ArrayBuffer/DataView framing, and
the continuous `while (true)` port loop — is blocked on three compiler gaps:

- **#1653** — `process.stdin.read(buffer, offset?)`: binary incremental stdin
  read into a typed buffer (keystone; unlocks both the read side and the
  continuous-loop design). Depends on #1654.
- **#1654** — DataView/ArrayBuffer-backed TypedArrays emit an **invalid wasm
  module** under `--target wasi` (the dual-mode heap/memory-global gap).
- **#1655** — `process.stdout.write(ArrayBuffer)`: accept an `ArrayBuffer`
  (and non-literal `Uint8Array`/`.subarray`) argument, not only a
  `Uint8Array` literal. Depends on #1654.

Until those land, `examples/native-messaging/host.ts` **deliberately** uses
the string-based `readStdin()` (#1481) for input and the `Uint8Array`-literal
`process.stdout.write` (#1651) for the length prefix — the working subset the
current compiler supports. `host.ts` is intentionally left unchanged.

## Reopened (2026-05-24) — premature `done`

This issue was closed `done` on 2026-05-24, but the example **does not actually
work end-to-end**: the original delivery's own findings (above) record that the
framed-response path is broken, and guest271314 (the original filer, #389) has
since reported the example doesn't work as shipped. A non-working example is
not done. Reopened to `in-progress`.

The previous delivery also leaned on a **bespoke `readStdin()` intrinsic**,
which is the wrong shape per the project's no-bespoke-builtins direction. The
chosen direction: host capabilities are exposed as **standard Node.js APIs**
(`process.stdin` / `process.stdout`) that guest TypeScript already knows —
never as invented intrinsics. guest271314's feedback **"I don't see an
implementation of `readStdin`"** is the motivating signal: intrinsics aren't
real APIs (no Node reference, no ecosystem familiarity, nothing to import), so
the example must be rewritten onto the standard APIs.

## Node-style rewrite plan (gated on #1653 + #1654)

The rewrite below is **dispatched only after #1653 and #1654 land**. It does not
happen in this plan-only PR.

### 1. Rewrite `host.ts` onto standard Node APIs

Rewrite `examples/native-messaging/host.ts` to use **only standard Node.js
APIs** — no bespoke builtins:

- **Read side** — `process.stdin.read(buffer, offset?)` (#1653, the keystone)
  for the framed read loop:
  1. Read exactly the **4-byte LE length header** into a 4-byte buffer.
  2. Decode the `uint32` length with `DataView.getUint32(0, true)` (needs #1654).
  3. Read exactly **N body bytes** into an N-byte buffer.
  4. `JSON.parse` the UTF-8 body.
- **Write side** — `process.stdout.write()` (#1651, already shipped) for the
  response: write the **4-byte LE length prefix** then the JSON body, no
  newline. Build the prefix with `Buffer` / `DataView.setUint32(0, len, true)`
  over an `ArrayBuffer` (needs #1654).
- Model the read-header-then-read-body framing + the continuous
  `while (true)` port loop on guest271314's reference
  [`nm_typescript.ts`](https://github.com/guest271314/NativeMessagingHosts/blob/main/nm_typescript.ts)
  — **credit guest271314** in the example header. This is the Node/TypeScript
  analogue of the AssemblyScript reference, expressed in exactly the standard
  APIs js2wasm now mimics.

### 2. Deprecate / remove the bespoke `readStdin()`

**Remove `readStdin()` from the example entirely** (the `declare function
readStdin(): string;` line and all call sites). It is replaced by
`process.stdin.read()` (#1653). No bespoke builtins remain in the example after
the rewrite.

### 3. Incorporate guest271314's PR #589 improvements (with attribution)

guest271314's PR #589 adds a real MV3 web-extension scaffold around the example.
Incorporate its improvements **with attribution to guest271314** — but **fix its
two flaws**:

- **Adopt (attributed to guest271314):**
  - `background.js` — MV3 service-worker that opens the native-messaging port.
  - `manifest.json` — repurposed/added as the **web-extension manifest** (MV3).
  - `nm_js2wasm.json` — the **native-host manifest** (the `path` + `type:
    "stdio"` + `allowed_origins` descriptor Chrome reads).
  - The accompanying file renames from PR #589.
- **Fix flaw 1 — runner shebang Wasm proposals:** the `nm_js2wasm.sh` runner
  must pass `-W gc=y,function-references=y,tail-call=y,exceptions=y` to wasmtime,
  **NOT** `-W all-proposals=y`. `all-proposals=y` enables stack-switching, which
  breaks wasmtime 44 with a stack-switching error. Pin the exact proposal set
  js2wasm output needs.
- **Fix flaw 2 — runner robustness:** restore the **executable bit** on the
  runner script and use a **portable path-resolution** scheme (resolve the
  `.wasm` relative to the script's own location, not a hard-coded absolute
  path), so the native-host manifest's `path` works regardless of install
  location.

### Acceptance

- The example works **end-to-end under real wasmtime**: a framed
  `{"ping":true}` request (4-byte LE prefix + JSON body on fd=0) produces a
  correct framed response (4-byte LE prefix + JSON body on fd=1), verified by
  `examples/native-messaging/smoke-test.sh`.
- **No bespoke builtins remain** — input via `process.stdin.read()`, output via
  `process.stdout.write()`, framing via `Buffer`/`DataView`/`ArrayBuffer`.
- The MV3 scaffold (`background.js`, web-extension `manifest.json`,
  `nm_js2wasm.json`) is present and credited to guest271314; the runner uses the
  pinned proposal set, is executable, and resolves the `.wasm` portably.

### Sequencing / external-PR note

- The rewrite is **dispatched after #1653 + #1654 land** (depends_on). Do not
  start the `host.ts` rewrite before the binary stdin read + ArrayBuffer/DataView
  validity are in.
- **HOLD — do not merge guest271314's PR #589 until guest has an affirmative
  CLA acceptance recorded (gated on #1660).** Our current `cla-check` workflow
  is a no-op placeholder that records nothing, so we have no evidence guest271314
  ever accepted the CLA. PR #589 must wait behind a real CLA gate (#1660) before
  it can land.
- **How to integrate vs guest271314's PR #589 is a maintainer decision.** Do
  **not** clobber the external PR — coordinate so guest's contribution lands
  with attribution rather than being silently re-implemented. This plan
  describes the target shape; the merge mechanics are the maintainer's call.
