// edge.js — a JS provider for the `node:fs` host-import interface (#1772 Phase 1).
//
// A js2wasm module compiled with `--target wasi --link-node-shims` imports its
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
