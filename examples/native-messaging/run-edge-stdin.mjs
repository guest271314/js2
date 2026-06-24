// run-edge-stdin.mjs — run a js2wasm `process.stdin`-reactor module under native
// Node via the edge.js async provider, with the REAL fd 0/1/2 (#2635 Phase 3).
//
// Usage:  node run-edge-stdin.mjs <user.wasm>
//
// The user module is compiled `--target wasi` from a program that touches
// `process.stdin` (a Readable). That wires the #2632 async event-loop reactor
// into `_start`, which drives `poll_oneoff` / `fd_read` / `fd_write` DIRECTLY as
// `wasi_snapshot_preview1` imports over the module's OWN exported memory.
//
// `createNodeStdinWasiProvider` (in edge.js) provides that `wasi_snapshot_preview1`
// surface, fed by Node's REAL `process.stdin` 'data'/'end' events (mechanism 2:
// pre-drain to EOF, then run `_start`). So this process's actual stdin (fd 0)
// carries the bytes and its stdout (fd 1) carries the output — exactly as under
// wasmtime's native WASI, from the SAME compiled binary. This is the native-Node
// arm of the same-binary async dual-provider compatibility proof (#2635).
//
// Pipe input into stdin and the program's output (echo / line-count / …) comes
// back on stdout, byte-identical to `wasmtime run <user.wasm>`.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createNodeStdinWasiProvider } from "./edge.js";

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = process.argv[2] ? resolve(process.argv[2]) : resolve(here, "out", "stdin_js2wasm.wasm");

const userBinary = readFileSync(wasmPath);
const provider = createNodeStdinWasiProvider();
await provider.run(userBinary);
