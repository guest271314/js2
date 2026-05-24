# Chrome Native Messaging host, compiled by js2wasm to standalone WASI

Chrome's [Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
protocol lets a browser extension talk to a native binary on the user's
machine. The browser launches the host process and exchanges messages over the
process's **stdin** and **stdout**, framing each message as a **4-byte
little-endian length prefix** followed by a **UTF-8 JSON body**.

This is a natural fit for `--target wasi`: compile a TypeScript host to a single
`.wasm`, run it under `wasmtime`/`wasmer`, and point Chrome at a thin wrapper
script. This directory contains:

```
examples/native-messaging/
  host.ts        ← the TypeScript host (compiled with --target wasi)
  README.md      ← this file
  manifest.json  ← Chrome native-host manifest template
  run.sh         ← wasmtime/wasmer wrapper Chrome invokes
```

## Status: read this before wiring into Chrome

This example is **honest about what the WASI target can do today**. The
message-processing core — reading the JSON body off stdin (fd=0), routing
debug to stderr (fd=2), and emitting a JSON response on stdout (fd=1) — is the
part js2wasm exercises. But two gaps mean it is **not yet a drop-in Chrome
host**:

| Capability | Status | Detail |
|------------|--------|--------|
| Read framed message from stdin | works | `readStdin()` drains fd=0 to EOF as a string (#1481) |
| Decode the 4-byte LE length prefix | works | byte math on `charCodeAt` of the first 4 code units |
| Route debug to stderr (fd=2) | works | `console.error` / `console.warn` (#1493) — keeps the stdout protocol stream clean |
| Print a **string literal** to stdout | works | `console.log("…")` emits UTF-8 + `\n` (#1480) |
| Print a **runtime/computed string** to stdout | **broken** | non-literal string values currently render as a corrupted `[object]` placeholder instead of their content — see "Known compiler gaps" below |
| Emit the **binary 4-byte LE length prefix** on stdout | **not supported** | there is no raw-byte stdout API; `console.log` UTF-8-encodes its argument and appends a newline, so arbitrary bytes (including the NUL bytes a length prefix needs) can't be written |

So today this host demonstrates the **read → decode → process** path
end-to-end, but it cannot frame its response the way Chrome's protocol
requires. Until the gaps below close, treat this as a **protocol-integration
walkthrough + working stdin reader**, not a production Chrome host.

### Known compiler gaps (follow-up issues)

- **Raw-byte stdout for the length prefix.** Chrome's framing needs four
  arbitrary bytes (a little-endian `uint32`) written verbatim to fd=1. The
  WASI stdout path only writes UTF-8-encoded strings via `console.log`, which
  also appends a trailing newline. A raw-byte stdout primitive (e.g. a
  `writeStdout(bytes: Uint8Array)` builtin lowering directly to `fd_write`
  with no newline) is required. *Filed as a follow-up to this issue.*
- **Runtime string content on stdout.** `console.log` of a non-literal string
  (a variable, template interpolation, or concatenation) currently emits a
  corrupted mix of the real bytes and the `[object]` placeholder under
  `--target wasi`, because the WASI value-to-stdout path treats `ref`
  (NativeString) values as the "other" fallback case. Only string literals and
  numeric values print cleanly. *Filed as a follow-up to this issue.*

## The host source

[`host.ts`](./host.ts) reads the whole framed message from stdin, strips and
decodes the 4-byte length prefix, logs diagnostics to **stderr** (so they never
corrupt the stdout protocol stream), and writes a JSON response. The
application logic — here, echoing the received body inside a wrapper object —
is the part you'd replace for a real host.

## Build to `.wasm`

```bash
mkdir -p examples/native-messaging/out
npx js2wasm examples/native-messaging/host.ts --target wasi -o examples/native-messaging/out
```

This produces `out/host.wasm`. The module imports only from
`wasi_snapshot_preview1` (`fd_read`, `fd_write`) — no `env.*` imports — so it
runs on any standards-compliant WASI preview1 runtime.

> The `-o` flag is an **output directory**, not a filename. js2wasm names the
> output after the input basename (`host.wasm`).

## Run it under a WASI runtime

`run.sh` wraps the runtime invocation. wasmtime is **not bundled** with this
repo — install it from <https://wasmtime.dev> (or use `wasmer` /
[wazero](https://github.com/tetratelabs/wazero); see
[`../wasi/README.md`](../wasi/README.md) for the full runtime matrix and how to
wrap a `.wasm` as a single self-contained native executable).

Once built, exercise the read → decode → respond loop by piping a framed
message. The 4-byte prefix below (`\x0d\x00\x00\x00`) declares a 13-byte body
`{"ping":true}`:

```bash
printf '\x0d\x00\x00\x00{"ping":true}' | ./examples/native-messaging/run.sh
```

You'll see the host's stderr diagnostic (received-length + decoded body
length) and its stdout response. **Note** the response framing is subject to
the stdout gaps documented above — verify against "Status" before relying on
the exact bytes.

> If you don't have a WASI runtime installed, you can still confirm the module
> is valid the same way the [`../wasi/README.md`](../wasi/README.md) Node
> snippet does — `WebAssembly.compile(readFileSync('out/host.wasm'))` — and
> drive it against js2wasm's own `buildWasiPolyfill()` for a JS-side
> round-trip.

## Wire it into Chrome

1. **Build** `out/host.wasm` (above) and make sure `run.sh` is executable
   (`chmod +x run.sh`).

2. **Edit `manifest.json`**:
   - `path` → the **absolute** path to `run.sh` (Chrome requires an absolute
     path and does not set a predictable working directory).
   - `allowed_origins` → `chrome-extension://YOUR_EXTENSION_ID/` for the
     extension that will connect. Find the ID on `chrome://extensions` with
     Developer mode enabled.

3. **Install the manifest** in the per-platform location Chrome scans:

   | Platform | Manifest location |
   |----------|-------------------|
   | Linux | `~/.config/google-chrome/NativeMessagingHosts/com.example.js2wasm_host.json` |
   | macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.example.js2wasm_host.json` |
   | Windows | a registry key `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.example.js2wasm_host` whose default value is the absolute path to the manifest `.json` |

   The manifest **filename** must match the host `name` field
   (`com.example.js2wasm_host`). On Windows, `run.sh` won't run directly —
   use a `run.bat` (`@echo off` + `wasmtime "%~dp0out\host.wasm"`) and point
   `path` at the `.bat`.

4. **Connect from the extension.** With the `nativeMessaging` permission in the
   extension manifest:

   ```js
   const port = chrome.runtime.connectNative("com.example.js2wasm_host");
   port.onMessage.addListener((msg) => console.log("from host:", msg));
   port.onDisconnect.addListener(() => console.log("host disconnected"));
   port.postMessage({ ping: true });
   ```

   Chrome handles the 4-byte length framing on its side; the host sees the
   raw bytes on stdin and must produce correctly framed bytes on stdout — the
   piece blocked on the stdout gaps above.

## Reference hosts in other runtimes

The protocol shape here mirrors the runtime-comparison examples collected at
[guest271314/native-messaging-webassembly](https://github.com/guest271314/native-messaging-webassembly):
`nm_assemblyscript.ts`, `nm_javy.js`, and `nm_qjs_wasi.js`. They are useful for
seeing the full length-prefixed read/write loop in runtimes that already expose
raw-byte stdio.
