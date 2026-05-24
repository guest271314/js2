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

## Status: a working drop-in Chrome host

This host now exercises the **full** Native Messaging loop under `--target
wasi`: read the framed JSON message off stdin (fd=0), route debug to stderr
(fd=2), and write a **correctly framed** JSON response — the binary 4-byte
little-endian length prefix plus the JSON body — to stdout (fd=1) with no
trailing newline. The two stdout gaps that previously blocked this are closed
(#1618, #1651).

| Capability | Status | Detail |
|------------|--------|--------|
| Read framed message from stdin | works | `readStdin()` drains fd=0 to EOF as a string (#1481) |
| Decode the 4-byte LE length prefix | works | byte math on `charCodeAt` of the first 4 code units |
| Route debug to stderr (fd=2) | works | `console.error` / `console.warn` (#1493) — keeps the stdout protocol stream clean |
| Print a **string literal** to stdout | works | `console.log("…")` emits UTF-8 + `\n` (#1480) |
| Print a **runtime/computed string** to stdout | works | `console.log(x)` / `process.stdout.write(x)` of a variable, concatenation, or template literal emit the actual content (#1618) |
| Write a **string** to stdout with no newline | works | `process.stdout.write(str)` → `fd_write(1, …)`, no `\n` (#1651) |
| Emit the **binary 4-byte LE length prefix** on stdout | works | `process.stdout.write(new Uint8Array([…]))` writes raw bytes (incl. NUL) verbatim to fd=1 (#1651) |

The response is framed with `process.stdout.write` — a `Uint8Array` for the
binary length prefix, then the JSON body string — mirroring the Node.js host
API used by the AssemblyScript reference (`nm_assemblyscript.ts`). It is a
drop-in Chrome host; the only external dependency is a WASI preview1 runtime to
launch it (see "Run it" below).

## The host source

[`host.ts`](./host.ts) reads the whole framed message from stdin, strips and
decodes the 4-byte length prefix, logs diagnostics to **stderr** (so they never
corrupt the stdout protocol stream), and writes a JSON response. The
application logic — here, echoing the received body inside a wrapper object —
is the part you'd replace for a real host.

## Build to `.wasm`

From the repo root (works immediately after `pnpm install`, no build step):

```bash
mkdir -p examples/native-messaging/out
npx tsx src/cli.ts examples/native-messaging/host.ts --target wasi -o examples/native-messaging/out
```

(Once the package is built — `pnpm run build` — or installed from npm, you can
use the `js2wasm` bin directly: `npx js2wasm host.ts --target wasi -o out`.)

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
length) and its stdout response, framed with the binary 4-byte LE length
prefix followed by the JSON body — exactly the bytes Chrome expects.

For an automated byte-exact check (build + run under wasmtime, asserting the
stdout frame and a clean stderr), run [`smoke-test.sh`](./smoke-test.sh) —
the same script CI runs (`.github/workflows/native-messaging-smoke.yml`):

```bash
./examples/native-messaging/smoke-test.sh
```

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
   raw bytes on stdin and produces correctly framed bytes on stdout via
   `process.stdout.write` (a `Uint8Array` prefix + the JSON body).

## Reference hosts in other runtimes

The protocol shape here mirrors the runtime-comparison examples collected at
[guest271314/native-messaging-webassembly](https://github.com/guest271314/native-messaging-webassembly):
`nm_assemblyscript.ts`, `nm_javy.js`, and `nm_qjs_wasi.js`. They are useful for
seeing the full length-prefixed read/write loop in runtimes that already expose
raw-byte stdio.
