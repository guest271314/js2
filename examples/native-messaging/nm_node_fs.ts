// Native Messaging host, compiled to standalone WASI by js2wasm — the **node:fs**
// synchronous-stdio variant.
//
//   npx js2wasm examples/native-messaging/nm_node_fs.ts --target wasi -o out
//
// `--target wasi` ALONE (no `--link-node-shims`) emits a SELF-CONTAINED WASI
// Preview-1 command module: it imports ONLY `wasi_snapshot_preview1` (fd_read /
// fd_write), owns + exports its own `memory`, and runs directly under a WASI
// host such as wasmtime — no node:fs shim, no Node runtime (#2655). This is the
// loopdive/js2#389 reporter's exact use case: a host that runs under a WASI host,
// explicitly "not chasing Node.js".
//
// This source uses REAL Node fd-based synchronous IO — `fs.readSync(fd, …)` /
// `fs.writeSync(fd, …)` from `node:fs` — so the SAME file ALSO runs UNMODIFIED
// under real `node`. `fs.readSync` / `fs.writeSync` are the faithful synchronous
// primitives (this is also what Javy uses: `Javy.IO.readSync`). `readSync(0,…)` /
// `writeSync(1,…)` are fd-based (integer fd 0=stdin, 1=stdout), NOT path-based —
// no filesystem involved; under real node they call the real fs.
//
//   npx js2wasm examples/native-messaging/nm_node_fs.ts --target wasi --link-node-shims -o out
//
// is the VARIANT that lowers the same calls to imported `node:fs` shim calls
// (`node-fs.wat`, which maps them to WASI fd_read / fd_write) — useful when the
// same binary should link against an external `node:fs` provider rather than
// owning the syscalls itself.
//
// Native Messaging protocol frames each message as a 4-byte little-endian length
// prefix followed by a UTF-8 **JSON** body, exchanged over the host process's
// stdin (fd=0) and stdout (fd=1). See:
//   https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
//
// Two hard browser constraints drive the response shape:
//   1. Browser deserializes EVERY host->extension message as JSON, so each frame
//      we write must be a complete, valid JSON value — not an arbitrary byte
//      slice. (A non-JSON frame is rejected with "The sender sent an invalid
//      JSON message; message ignored.")
//   2. A single host->extension message is capped at 1 MiB.
//
// So a large message — e.g. `port.postMessage(Array(209715*64))`, ~64 MiB of
// `[null,null,...]` — is re-chunked into a sequence of <=1 MiB valid JSON arrays
// whose elements, concatenated by the receiver, reproduce the original array.
// A message that already fits in one frame is echoed verbatim.
//
// The Native Messaging FRAMING + browser-cap re-chunk streaming itself lives in
// the shared, host-independent core `nm_sync_framing.ts` (#2778) — this file is
// just the thin node:fs adapter that injects `readSync(0,…)` / `writeSync(1,…)`
// into the `runNmHost` seam and runs it with a **1 MiB re-chunk cap** (the
// browser per-host->extension-message limit). The re-chunk is this variant's
// deliberate demo: a body > 1 MiB streams back through a single reused 1 MiB
// buffer as a sequence of valid <=1 MiB JSON frames, so resident memory stays
// flat (~a couple MiB) regardless of message size. `nm_deno.ts` injects Deno
// stdio with NO cap (verbatim echo) into the SAME core.
//
// The seam is two FUNCTION references (`nodeFsRead` / `nodeFsWrite`), not an
// object: passing a struct value across the bundled-module boundary traps at
// runtime under `--target wasi` today, while function references cross cleanly
// (#2778 — see the note atop `nm_sync_framing.ts`).
//
// js2wasm support today (#2631):
//   - stdin  : readSync(0, buf, { offset, length }) does one binary, incremental
//              fd=0 read into the caller's typed buffer, returning the byte count.
//   - stdout : writeSync(1, bytes, off) writes raw bytes to fd=1 with NO trailing
//              newline; the partial-write loop drains the whole buffer.

import { readSync, writeSync } from "node:fs";
import { runNmHost } from "./nm_sync_framing";

// ONE incremental fd=0 read filling the WHOLE buffer it is handed (offset 0,
// length = buf.length); returns the byte count (0 at EOF — the core treats
// `<= 0` as EOF).
function nodeFsRead(buf: Uint8Array): number | null {
  return readSync(0, buf, { offset: 0, length: buf.length });
}

// Drain the WHOLE of `buf` to fd 1; the offset form writes from `buf[n..]`.
function nodeFsWrite(buf: Uint8Array): void {
  let n = 0;
  while (n < buf.length) {
    const w = writeSync(1, buf, n);
    if (w <= 0) return; // error; nothing more we can do on this frame
    n = n + w;
  }
}

export function main(): void {
  // Largest body the browser Native Messaging implementation accepts in one
  // host->extension message, and the size of the single scratch buffer the whole
  // stream flows through — passed as the shared core's re-chunk cap.
  //
  // Kept a LOCAL const (not a module-level one) on purpose: a module-level const
  // lowers to a Wasm GLOBAL, and passing that global as the cap argument across
  // the bundled-module call into the shared core mis-lowers under `--target wasi`
  // → a runtime fault (a clean compile, but a fault) — the same class of node:fs
  // multi-file index-shift gap noted in `nm_sync_framing.ts` (#2778). A local
  // const (or an inline literal) compiles to a plain `i32.const` operand and is
  // unaffected.
  const frameChunk = 1024 * 1024;
  // Re-chunk bodies larger than the browser 1 MiB cap into valid <=1 MiB JSON
  // frames; smaller bodies echo verbatim. Streams to EOF / a zero-length frame.
  runNmHost(nodeFsRead, nodeFsWrite, frameChunk);
}

// Invoke the entry point. js2wasm compiles a top-level call into the module's
// `_start`, and under real `node` this runs the host loop directly.
main();
