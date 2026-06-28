// edge.js — a JS provider for the `node:fs` host-import interface (#1772 Phase 1).
//
// A js2wasm module compiled with `--target wasi --link node:fs` imports its
// fd-based synchronous IO from `node:fs`:
//
//   (import "node:fs" "memory"    (memory …))
//   (import "node:fs" "readSync"  (func (param i32 i32 i32) (result i32)))
//   (import "node:fs" "writeSync" (func (param i32 i32 i32) (result i32)))
//
// The module declares WHAT host API it needs (`node:fs`), never HOW it is
// satisfied. Under wasmtime that interface is provided by the pure-WASI
// `node-fs.wat` shim (which maps it to `fd_read`/`fd_write`). Under native Node
// THIS adapter provides it by delegating to the REAL `node:fs` module over the
// module's exported linear memory.
//
// The canonical per-member pointer-ABI (see docs/architecture/node-fs-abi.md):
//
//   readSync(fd, ptr, len) -> i32   read up to len bytes from fd into mem[ptr,ptr+len)
//   writeSync(fd, ptr, len) -> i32  write mem[ptr,ptr+len) to fd
//
// `fd` is load-bearing: 0=stdin, 1=stdout, 2=stderr (writeSync(2,…) → stderr).
// This is fd-based, filesystem-free — no path_open, no preopens.
//
// Calling-convention impedance: real `fs.readSync(fd, buffer, offset, length,
// position)` ≠ the wasm `readSync(fd, ptr, len)`. So native Node is NEVER a
// direct provider — this adapter translates pointer-ABI ↔ Buffer-ABI over the
// shared memory. That irreducible translation is edge.js's entire job.

import * as fs from "node:fs";

/**
 * Build a `node:fs` import object backed by the real Node `fs` module.
 *
 * Memory-ownership model (mirrors node-fs.wat): the PROVIDER owns + exports the
 * linear memory; the user module imports memory index 0 from `node:fs`. So
 * edge.js creates the `WebAssembly.Memory` and hands it to the user module
 * alongside `readSync`/`writeSync`. There is no instantiation cycle — edge.js
 * imports nothing from the user module.
 *
 * @param {object} [opts]
 * @param {number} [opts.initialPages=3] initial memory size in 64KiB pages
 *   (min 3 matches the user module's reservation; mirrors node-fs.wat).
 * @param {number} [opts.maximumPages] optional max pages.
 * @param {typeof import("node:fs")} [opts.fsImpl] override the fs backend
 *   (defaults to the real `node:fs`); used by tests / JS+WASI polyfills.
 * @returns {{ memory: WebAssembly.Memory, importObject: { "node:fs": object } }}
 */
export function createNodeFsProvider(opts = {}) {
  const { initialPages = 3, maximumPages, fsImpl = fs } = opts;
  const memory = new WebAssembly.Memory(
    maximumPages != null ? { initial: initialPages, maximum: maximumPages } : { initial: initialPages },
  );

  // readSync(fd, ptr, len): fill mem[ptr,ptr+len) from fd. Real Node:
  //   fs.readSync(fd, buffer, offset, length, position)
  // position=null reads sequentially from the fd's cursor (works for pipes,
  // ttys, and files alike). We read into a scratch Buffer then copy into wasm
  // memory, because fs.readSync wants a Node Buffer, and a Buffer view onto the
  // wasm ArrayBuffer can be invalidated by a memory.grow between calls.
  const readSync = (fd, ptr, len) => {
    if (len <= 0) return 0;
    const scratch = Buffer.allocUnsafe(len);
    let n;
    try {
      n = fsImpl.readSync(fd, scratch, 0, len, null);
    } catch (e) {
      // EOF on some platforms surfaces as an error; treat EOF/EAGAIN as 0.
      if (e && (e.code === "EOF" || e.code === "EAGAIN")) return 0;
      throw e;
    }
    if (n > 0) {
      new Uint8Array(memory.buffer, ptr, n).set(scratch.subarray(0, n));
    }
    return n;
  };

  // writeSync(fd, ptr, len): write mem[ptr,ptr+len) to fd. Real Node:
  //   fs.writeSync(fd, buffer, offset, length, position)
  // We copy the wasm byte range into a standalone Buffer first (so a concurrent
  // memory.grow can't detach the view mid-syscall), then write it. Returns the
  // count written; a short write is legal and the caller loops.
  const writeSync = (fd, ptr, len) => {
    if (len <= 0) return 0;
    const bytes = Buffer.from(new Uint8Array(memory.buffer, ptr, len)); // copy
    return fsImpl.writeSync(fd, bytes, 0, len, null);
  };

  return {
    memory,
    importObject: { "node:fs": { memory, readSync, writeSync } },
  };
}

/**
 * Instantiate a js2wasm `node:fs`-importing module with edge.js as the provider
 * and run its entry point. The module imports `node:fs` (memory + readSync +
 * writeSync); edge.js owns the memory and delegates IO to real `node:fs`.
 *
 * @param {BufferSource} userBinary the compiled user wasm (imports node:fs).
 * @param {object} [opts] forwarded to createNodeFsProvider, plus:
 * @param {string} [opts.entry="main"] exported entry to invoke (falls back to
 *   `_start`).
 * @returns {Promise<{ instance: WebAssembly.Instance, memory: WebAssembly.Memory }>}
 */
export async function runWithEdge(userBinary, opts = {}) {
  const { entry = "main", ...providerOpts } = opts;
  const { memory, importObject } = createNodeFsProvider(providerOpts);
  const { instance } = await WebAssembly.instantiate(userBinary, {
    ...importObject,
    env: {},
  });
  const run = instance.exports[entry] ?? instance.exports._start;
  if (typeof run !== "function") {
    throw new Error(`edge.js: user module exports no \`${entry}\` or \`_start\``);
  }
  run();
  return { instance, memory };
}

// ───────────────────────────────────────────────────────────────────────────
// #2635 Phase 3 — async `process.stdin` provider (the ASYNC tier).
//
// The synchronous `node:fs` tier above (Phase 1) satisfies fd-based readSync/
// writeSync as two closures. Node's ASYNC surface — `process.stdin` as a
// `Readable` — has no synchronous fd primitive to lower to; instead a js2wasm
// module compiled `--target wasi` that touches `process.stdin` wires the #2632
// async event-loop reactor into its `_start`, which drives `poll_oneoff` /
// `fd_read` / `fd_fdstat_set_flags` / `clock_time_get` / `fd_write` DIRECTLY as
// `wasi_snapshot_preview1` imports (the reactor is WASI-internal, NOT a
// swappable `node:fs` member). So the provider seam for the async path is the
// `wasi_snapshot_preview1` import surface — not `node:fs`.
//
//   Host class          Provider          Satisfies the stdin reactor by
//   ──────────────────  ────────────────  ─────────────────────────────────────
//   Pure WASI (wasmtime) the host kernel   real poll_oneoff/fd_read on fd0 over
//                                          the module's own exported memory.
//   Native Node (JS)     edge.js (below)   a wasi_snapshot_preview1 shim whose
//                                          fd_read/poll_oneoff are fed by Node's
//                                          REAL process.stdin 'data'/'end'
//                                          events — the JS host's event loop.
//
// The byte-ABI is unchanged in spirit from docs/architecture/node-fs-abi.md
// (fd-based, pointer over shared memory); only the named import surface differs.
//
// Dependency choice (mirrors the Phase-1 "thin adapter, irreducible job" note):
// this stays a ZERO-DEPENDENCY example (only `node:` imports), so the minimal
// wasi_snapshot_preview1 subset is inlined here rather than imported from the
// built `dist/` runtime. The semantics deliberately MIRROR `buildWasiPolyfill`
// in `src/runtime.ts` (the canonical #2632 polyfill): fd0-readable iff bytes
// remain or EOF, 0-byte fd_read == EOF, fd_fdstat_set_flags no-op, raw-byte
// fd_write. Keeping it inlined makes this a genuinely INDEPENDENT provider that
// must AGREE byte-for-byte with both wasmtime AND the in-tree polyfill — a
// stronger proof than re-exporting the polyfill verbatim. If the semantics ever
// drift, prefer reusing buildWasiPolyfill via a small edge-wasi.mjs helper.
//
// The sync/async impedance: the wasm reactor's `_start` is a SYNCHRONOUS
// poll_oneoff-blocking loop, but Node's stdin is ASYNC (data arrives on future
// loop ticks). We therefore CANNOT call `_start()` and let poll_oneoff block —
// that deadlocks waiting for data that only arrives when the JS loop is free.
// MECHANISM 2 (pre-drain, used here): `await` Node's real `process.stdin` to
// 'end', collecting all bytes into the queue (this phase genuinely borrows the
// JS event loop), THEN call `_start()` so every poll_oneoff finds data/EOF
// immediately and never truly blocks — exactly the proven `setStdin(bytes)` +
// `_start()` path #2632 validated against wasmtime.
//   ┌─ P3-d SEAM ─────────────────────────────────────────────────────────────┐
//   │ Mechanism 1 (true incremental loop-borrow) would asyncify `_start`'s     │
//   │ poll_oneoff suspend points so the wasm stack yields back to Node between │
//   │ 'data' events and resumes incrementally. That is the deferred follow-up  │
//   │ #2635/P3-d; the pre-drain below is the first-acceptance mechanism.       │
//   └──────────────────────────────────────────────────────────────────────────┘

const __WASI_ERRNO_SUCCESS = 0;

/**
 * Build a `wasi_snapshot_preview1` import object whose fd0 (stdin) is fed by a
 * caller-supplied byte source, satisfying the #2632 async `process.stdin`
 * reactor. Returns `{ importObject, run }`; the module OWNS + EXPORTS its own
 * memory (pure `--target wasi`), so the provider binds memory lazily from
 * `instance.exports.memory` after instantiation.
 *
 * @param {object} [opts]
 * @param {() => Promise<Buffer[]>} [opts.collectStdin] async producer of all
 *   stdin chunks (pre-drained to EOF). Defaults to draining the process's REAL
 *   `process.stdin` to 'end' — i.e. borrowing Node's event loop. Override in
 *   tests to inject a fixed byte sequence without touching the real fd0.
 * @returns {{ importObject: { wasi_snapshot_preview1: object }, run: (binary: BufferSource, entry?: string) => Promise<{ instance: WebAssembly.Instance, memory: WebAssembly.Memory }> }}
 */
export function createNodeStdinWasiProvider(opts = {}) {
  const collectStdin = opts.collectStdin ?? drainProcessStdin;

  let memory; // bound after instantiation (module exports its own memory)
  /** @type {Buffer[]} */
  const queue = []; // pre-drained stdin chunks
  let qHead = 0; // index of the current chunk in `queue`
  let qPos = 0; // byte offset within queue[qHead]

  // Total unread bytes left across the queue (drives fd0 readiness + EOF).
  const remaining = () => {
    let n = -qPos;
    for (let i = qHead; i < queue.length; i++) n += queue[i].length;
    return n < 0 ? 0 : n;
  };

  // fd_read(fd0, iovs…): drain `queue` into wasm memory at each iovec base;
  // return the byte count. A 0-byte read == EOF (queue empty), mirroring
  // `__rl_stdin_drain`'s contract. Re-reads `memory.buffer` per call so a
  // memory.grow between calls can't leave us writing into a detached view.
  const fd_read = (fd, iovs, iovs_len, nread) => {
    if (!memory) return -1;
    const view = new DataView(memory.buffer);
    let total = 0;
    if (fd === 0) {
      for (let i = 0; i < iovs_len; i++) {
        const ptr = view.getUint32(iovs + i * 8, true);
        const len = view.getUint32(iovs + i * 8 + 4, true);
        if (len === 0) continue;
        let written = 0;
        while (written < len && qHead < queue.length) {
          const chunk = queue[qHead];
          if (qPos >= chunk.length) {
            qHead++;
            qPos = 0;
            continue;
          }
          const take = Math.min(len - written, chunk.length - qPos);
          new Uint8Array(memory.buffer, ptr + written, take).set(chunk.subarray(qPos, qPos + take));
          qPos += take;
          written += take;
          total += take;
        }
        if (written < len) break; // drained — partial fill ends this read
      }
    }
    view.setUint32(nread, total, true);
    return __WASI_ERRNO_SUCCESS;
  };

  // fd_write(fd, iovs…): write the RAW bytes verbatim to the real fd1/fd2.
  // Must be raw (NOT line-buffered through console.log) so the output is
  // byte-identical to wasmtime's native fd_write from the SAME binary.
  const fd_write = (fd, iovs, iovs_len, nwritten) => {
    if (!memory) return -1;
    const view = new DataView(memory.buffer);
    const sink = fd === 2 ? process.stderr : process.stdout;
    let total = 0;
    for (let i = 0; i < iovs_len; i++) {
      const ptr = view.getUint32(iovs + i * 8, true);
      const len = view.getUint32(iovs + i * 8 + 4, true);
      if (len > 0) sink.write(Buffer.from(new Uint8Array(memory.buffer, ptr, len))); // copy, then write
      total += len;
    }
    view.setUint32(nwritten, total, true);
    return __WASI_ERRNO_SUCCESS;
  };

  // poll_oneoff: report fd0 FD_READ as fired when bytes remain (pre-drained, so
  // it's "remaining || EOF"); else fire the CLOCK subscription (timeout elapses
  // instantly — there is never anything to truly wait for after pre-drain). If
  // fd0 is subscribed with no clock and no bytes, fire fd0 anyway so the
  // reactor's 0-byte (EOF) read ends the subscription instead of hanging.
  // Mirrors buildWasiPolyfill().poll_oneoff exactly.
  const poll_oneoff = (in_ptr, out_ptr, nsubs, nevents_out) => {
    if (!memory) return -1;
    const view = new DataView(memory.buffer);
    const subs = [];
    for (let s = 0; s < nsubs; s++) {
      const off = in_ptr + s * 48;
      const userdata = view.getBigUint64(off, true);
      const tag = view.getUint8(off + 8); // 0=CLOCK, 1=FD_READ
      const fd = tag === 1 ? view.getUint32(off + 16, true) : -1;
      subs.push({ type: tag, fd, userdata });
    }
    const fd0Readable = remaining() > 0;
    const fd0Sub = subs.find((x) => x.type === 1 && x.fd === 0);
    const clockSub = subs.find((x) => x.type === 0);
    const fired = [];
    if (fd0Sub && fd0Readable) fired.push(fd0Sub);
    else if (clockSub) fired.push(clockSub);
    else if (fd0Sub) fired.push(fd0Sub);
    else if (subs.length > 0) fired.push(subs[0]);
    let n = 0;
    for (const ev of fired) {
      const eoff = out_ptr + n * 32;
      for (let i = 0; i < 32; i++) view.setUint8(eoff + i, 0);
      view.setBigUint64(eoff, ev.userdata, true);
      view.setUint16(eoff + 8, 0, true); // errno = success
      view.setUint8(eoff + 10, ev.type); // 0=CLOCK, 1=FD_READ
      n++;
    }
    view.setUint32(nevents_out, n, true);
    return __WASI_ERRNO_SUCCESS;
  };

  // The reactor calls this once to set fd0 non-blocking; our fd_read is already
  // non-blocking against the JS queue, so it's a no-op ack (matches the polyfill).
  const fd_fdstat_set_flags = () => __WASI_ERRNO_SUCCESS;

  const monotonicStartNs = process.hrtime.bigint();
  const clock_time_get = (clockid, _precision, out_ptr) => {
    if (!memory) return 28; // EINVAL
    let nowNs = clockid === 1 ? process.hrtime.bigint() - monotonicStartNs : BigInt(Date.now()) * 1_000_000n;
    if (nowNs < 0n) nowNs = 0n;
    new DataView(memory.buffer).setBigUint64(out_ptr, nowNs, true);
    return __WASI_ERRNO_SUCCESS;
  };

  const proc_exit = (code) => {
    if (code) process.exitCode = code;
  };

  const wasi = {
    fd_read,
    fd_write,
    poll_oneoff,
    fd_fdstat_set_flags,
    clock_time_get,
    proc_exit,
  };

  const importObject = { wasi_snapshot_preview1: wasi };

  /**
   * Pre-drain stdin (mechanism 2), instantiate, bind the module's exported
   * memory, then run its `_start` (default). poll_oneoff thereafter finds
   * data/EOF immediately.
   */
  async function run(binary, entry = "_start") {
    const chunks = await collectStdin();
    for (const c of chunks) queue.push(c);
    const { instance } = await WebAssembly.instantiate(binary, { ...importObject, env: {} });
    memory = instance.exports.memory;
    if (!(memory instanceof WebAssembly.Memory)) {
      throw new Error("edge.js: stdin-WASI module must EXPORT its own `memory` (compile with --target wasi).");
    }
    const start = instance.exports[entry] ?? instance.exports._start;
    if (typeof start !== "function") {
      throw new Error(`edge.js: user module exports no \`${entry}\` or \`_start\``);
    }
    start();
    return { instance, memory };
  }

  return { importObject, run };
}

/**
 * Drain the process's REAL `process.stdin` to EOF, collecting every chunk. This
 * is where edge.js borrows Node's event loop: the 'data'/'end' events fire as
 * JS loop work, so the bytes piped to this process's fd0 are gathered before
 * the wasm reactor runs. Resolves with the collected chunks.
 * @returns {Promise<Buffer[]>}
 */
function drainProcessStdin() {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    process.stdin.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    process.stdin.on("end", () => resolve(chunks));
    process.stdin.on("error", (e) => reject(e));
  });
}
