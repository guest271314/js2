// run-edge.mjs — run a js2wasm `node:fs`-importing module under native Node via
// the edge.js provider, with REAL fds 0/1/2 (#1772 Phase 1).
//
// Usage:  node run-edge.mjs <user.wasm>
//
// edge.js delegates `node:fs` readSync/writeSync to the REAL `node:fs` module,
// so this process's actual stdin (fd 0) / stdout (fd 1) / stderr (fd 2) carry
// the bytes. Pipe a framed Native Messaging message into stdin and the framed
// echo comes back on stdout — exactly as under wasmtime + the node-fs.wat shim,
// from the SAME compiled binary. This is the native-Node arm of the
// same-binary dual-provider compatibility proof.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runWithEdge } from "./edge.js";

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath = process.argv[2] ? resolve(process.argv[2]) : resolve(here, "out", "nm_js2wasm_node_fs.wasm");

const userBinary = readFileSync(wasmPath);
await runWithEdge(userBinary, { entry: "main" });
