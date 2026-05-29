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
  host.ts          ← the TypeScript host (compiled with --target wasi)
  README.md        ← this file
  nm_js2wasm.json  ← Chrome native-host manifest template
  manifest.json    ← Web extension manifest
  nm_js2wasm.sh    ← wasmtime/wasmer wrapper Chrome invokes
  background.js    ← MV3 Web extension background `ServiceWorker` script
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
| Read framed message from stdin | works | `process.stdin.read(buf, offset?)` does a binary, incremental fd=0 read into the caller's buffer, returning the byte count (#1653); a read-until loop assembles exactly N bytes |
| Decode the 4-byte LE length prefix | works | byte math on the first 4 bytes of the read header buffer |
| Route debug to stderr (fd=2) | works | `console.error` / `console.warn` (#1493) — keeps the stdout protocol stream clean |
| Print a **string literal** to stdout | works | `console.log("…")` emits UTF-8 + `\n` (#1480) |
| Print a **runtime/computed string** to stdout | works | `console.log(x)` / `process.stdout.write(x)` of a variable, concatenation, or template literal emit the actual content (#1618) |
| Write a **string** to stdout with no newline | works | `process.stdout.write(str)` → `fd_write(1, …)`, no `\n` (#1651) |
| Emit the **binary 4-byte LE length prefix** on stdout | works | `process.stdout.write(new Uint8Array([…]))` writes raw bytes (incl. NUL) verbatim to fd=1 (#1651) |

The response is framed with `process.stdout.write` — a `Uint8Array` for the
binary length prefix, then the body bytes — mirroring the Node.js host API used
by the reference hosts (`nm_assemblyscript.ts`, `nm_javy.js`, `nm_qjs_wasi.js`).
It is a drop-in Chrome host; the only external dependency is a WASI preview1
runtime to launch it (see "Run it" below).

## The host source

[`host.ts`](./host.ts) follows the **3-symbol shape** the reference hosts use
across runtimes:

- **`getMessage()`** — reads the 4-byte little-endian length header, then
  exactly that many body bytes, via `process.stdin.read` read-until loops (a
  `readExact` helper handles short reads). It returns the body as a raw
  **`Uint8Array`** (a zero-length buffer signals EOF / a truncated frame). The
  body is **never** decoded to a JS string, so it round-trips byte-exactly at
  any size — including megabyte-scale messages (#389).
- **`sendMessage(message)`** — frames a `Uint8Array` body: writes the 4-byte LE
  length prefix, then the body bytes, to stdout with no trailing newline. Large
  bodies grow linear memory as needed (#389/#1723).
- **`main()`** — the continuous port loop: `const m = getMessage();
  sendMessage(m);`, looping until `getMessage()` returns an empty body.

Diagnostics go to **stderr** (so they never corrupt the stdout protocol
stream). The application logic — here, a **strict echo** that sends the received
body back verbatim, byte-for-byte, with no wrapper and no added bytes (so the
stdin→stdout round-trip is directly observable) — lives entirely in the loop
body and is the part you'd replace for a real host that decodes `message`,
dispatches on a command field, and frames a structured response with
`sendMessage()`. Carrying the body as bytes (rather than a string) is also
forward-compatible with Chromium's in-progress `Uint8Array` Native Messaging
support — the protocol body is fundamentally a byte buffer.

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

### What is `out/host.imports.js`?

Alongside `host.wasm`, js2wasm emits **`host.imports.js`** (plus `host.d.ts`).
It is the **generated host-imports glue** a compiled module needs when you
instantiate it from a JavaScript host. It re-exports `createImports`,
`instantiateBytes`, and `instantiateFromUrl` from the `js2wasm` runtime package,
wiring up the module's import manifest and string pool:

```js
import { instantiateBytes } from "./out/host.imports.js";
const { instance } = await instantiateBytes(wasmBytes, deps, options);
instance.exports.main();
```

For **this** example it is **not used at runtime**: the Native Messaging host
is a fully standalone `--target wasi` module whose only imports are the WASI
preview1 syscalls (`fd_read`/`fd_write`), which the runtime — `wasmtime`,
`wasmer`, `wazero`, or Node's WASI — supplies directly. So the `nm_js2wasm.sh`
wrapper launches `host.wasm` under a WASI runtime and `host.imports.js` is
never imported.

The glue file is emitted unconditionally by the compiler because the **same
module can also be driven from a JS host** (e.g. instantiated in the browser or
in Node via `WebAssembly.instantiate`), where the import wiring it provides is
required. Treat it as the JS-host on-ramp for the module; for the standalone
WASI path it is a harmless extra artifact you can ignore or delete.

## Run it under a WASI runtime

`nm_js2wasm.sh` wraps the runtime invocation. `wasmtime` is **not bundled** with this
repo — install it from <https://wasmtime.dev> (or use `wasmer` /
[wazero](https://github.com/tetratelabs/wazero); see
[`../wasi/README.md`](../wasi/README.md) for the full runtime matrix and how to
wrap a `.wasm` as a single self-contained native executable).

Once built, exercise the read → decode → respond loop by piping a framed
message. The 4-byte prefix below (`\x0d\x00\x00\x00`) declares a 13-byte body
`{"ping":true}`:

```bash
printf '\x0d\x00\x00\x00{"ping":true}' | ./examples/native-messaging/nm_js2wasm.sh
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

1. **Build** `out/host.wasm` (above) and make sure `nm_js2wasm.sh` is executable
   (`chmod +x nm_js2wasm.sh`).

2. **Edit `nm_js2wasm.json`**:
   - `path` → the **absolute** path to `nm_js2wasm.sh` (Chrome requires an absolute
     path and does not set a predictable working directory), and make sure the file is 
     set to executable.
   - `allowed_origins` → `chrome-extension://YOUR_EXTENSION_ID/` for the
     extension that will connect. Find the ID on `chrome://extensions` with
     Developer mode enabled after installing the unpacked Web extension.

3. **Install the manifest** in the per-platform location Chrome scans:

   | Platform | Manifest location |
   |----------|-------------------|
   | Linux | `~/.config/google-chrome/NativeMessagingHosts/nm_js2wasm.json` |
   | macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/nm_js2wasm.json` |
   | Windows | a registry key `HKCU\Software\Google\Chrome\NativeMessagingHosts\nm_js2wasm` whose default value is the absolute path to the manifest `.json` |

   The manifest **filename** must match the host `name` field
   (`nm_js2wasm`). On Windows, `nm_js2wasm.sh` won't run directly —
   use a `run.bat` (`@echo off` + `wasmtime "%~dp0out\host.wasm"`) and point
   `path` at the `.bat`.

4. **Connect from the extension.** With the `nativeMessaging` permission in the
   extension manifest:

   ```js
   const port = chrome.runtime.connectNative("nm_js2wasm");
   port.onMessage.addListener((msg) => console.log("from host:", msg));
   port.onDisconnect.addListener((_) => {
     console.log("host disconnected");
     if (chrome.runtime.lastError) {
       console.log(chrome.runtime.lastError);
     }
   }
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
