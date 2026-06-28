// Native Messaging host, compiled to standalone WASI by js2wasm — the **Deno**
// synchronous-stdio variant.
//
//   npx js2wasm examples/native-messaging/nm_js2wasm_deno.ts --target wasi -o out
//
// `--target wasi` emits a SELF-CONTAINED WASI Preview-1 command module: it
// imports ONLY `wasi_snapshot_preview1` (fd_read / fd_write), owns + exports its
// own `memory`, and runs directly under a WASI host such as wasmtime — no Deno
// runtime, no JS host (#2684). This is the loopdive/js2#389 reporter's exact use
// case: a host that runs under a WASI host, explicitly "not chasing Node.js".
//
// This source uses REAL Deno synchronous fd-based IO — `Deno.stdin.readSync` /
// `Deno.stdout.writeSync` — so the SAME file ALSO runs UNMODIFIED under real
// `deno` (which provides the `Deno` namespace):
//
//   deno run --allow-read --allow-write examples/native-messaging/nm_js2wasm_deno.ts
//
// Deno's stdio primitives are fd-based and synchronous, mapping 1:1 to WASI:
//
//   Deno.stdin.readSync(p: Uint8Array): number | null   // bytes read, null @EOF
//   Deno.stdout.writeSync(p: Uint8Array): number         // bytes written (fd 1)
//
// `readSync` returns `null` at end-of-stream — the faithful EOF signal the shared
// core uses to terminate the port loop. js2wasm lowers the `number | null` result
// to the compiler's native nullable representation (no JS host needed), so
// `=== null` works in the standalone module exactly as it does under real Deno.
//
// The Native Messaging FRAMING + verbatim streaming itself lives in the shared,
// host-independent core `nm_js2wasm_sync_framing.ts` (#2778) — this file is just the thin
// Deno adapter that injects `Deno.stdin.readSync` / `Deno.stdout.writeSync` into
// the `runNmHost` seam and runs it with NO re-chunk cap (verbatim byte echo).
// `nm_js2wasm_node_fs.ts` is the same core injected with `node:fs` IO and a 1 MiB cap;
// `nm_js2wasm_wasi_p1.ts` is the raw `wasi_snapshot_preview1` `fd_read`/`fd_write` form.
// All compile to the SAME pure-WASI-P1 shape; they differ only in which runtime's
// source-level API they additionally run under, unmodified.
//
// The seam is two FUNCTION references (`denoRead` / `denoWrite`), not an object:
// passing a struct value across the bundled-module boundary traps at runtime
// under `--target wasi` today, while function references cross cleanly (#2778 —
// see the note atop `nm_js2wasm_sync_framing.ts`).
//
// Native Messaging protocol: each message is a 4-byte little-endian length prefix
// followed by a UTF-8 JSON body, exchanged over fd 0 (stdin) / fd 1 (stdout). See
//   https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging

import { runNmHost } from "./nm_js2wasm_sync_framing";

// ONE Deno `readSync`: fills the whole buffer it is handed and returns the count,
// or `null` at EOF (the core treats `null` / `<= 0` as EOF).
function denoRead(buf: Uint8Array): number | null {
  return Deno.stdin.readSync(buf);
}

// Drain the WHOLE of `buf` to fd 1. Deno writes the entire buffer it is handed and
// returns the count, so on a partial write we continue with an exact-size copy of
// the unwritten tail (no subarray).
function denoWrite(buf: Uint8Array): void {
  let rest = buf;
  while (rest.length > 0) {
    const w = Deno.stdout.writeSync(rest);
    if (w <= 0) return; // error; nothing more we can do on this frame
    if (w >= rest.length) return; // whole buffer written
    const tail = new Uint8Array(rest.length - w);
    let i = 0;
    while (i < tail.length) {
      tail[i] = rest[w + i];
      i = i + 1;
    }
    rest = tail;
  }
}

// No fd-2 telemetry in the verbatim variant (matches the pre-dedup nm_js2wasm_deno). The
// verbatim path never invokes the diagnostics hook, so this is never called — it
// exists only to satisfy the shared core's `log` parameter.
function denoNoLog(declaredLen: number): void {
  // intentionally empty; `declaredLen` is referenced so strict typecheck is happy
  void declaredLen;
}

export function main(): void {
  // Verbatim echo: no browser re-chunk cap (maxFrameSize 0). Each framed message
  // is streamed back byte-for-byte until EOF / a zero-length shutdown frame.
  runNmHost(denoRead, denoWrite, denoNoLog, 0);
}

// Invoke the entry point. js2wasm compiles a top-level call into the module's
// `_start` (which wasmtime runs); under real `deno` this runs the host loop
// directly.
main();
