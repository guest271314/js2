// A small Node-oriented program: it emits a service manifest and a deploy
// marker using two of the most familiar Node platform APIs — `console` and
// `node:fs` (`writeFileSync`).
//
// The point of this example is *where it runs*: js2wasm compiles it to a
// standalone WebAssembly module that executes on a WASI host (Wasmtime), with
// `node:fs` lowered to WASI filesystem syscalls. No Node.js engine is present
// at deploy time — the platform surface is preserved, the runtime substrate is
// not Node.

import { writeFileSync } from "node:fs";

console.log("Generating deployment artifacts (node:fs on Wasmtime)...");

writeFileSync(
  "manifest.json",
  '{\n  "name": "checkout-service",\n  "version": "2.4.1",\n  "runtime": "wasm32-wasi"\n}\n',
);
console.log("  wrote manifest.json");

writeFileSync(
  "DEPLOY.md",
  "# checkout-service\n\nBuilt to WebAssembly via js2wasm.\nRuns on any WASI host — Node.js is not required at deploy time.\n",
);
console.log("  wrote DEPLOY.md");

console.log("Done. Two files written through the node:fs platform API.");
