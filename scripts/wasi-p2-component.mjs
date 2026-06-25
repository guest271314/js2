#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2643 Slice A — adapt a `--target wasi` Preview-1 core module into a WASI
// Preview-2 *component* using the official `@bytecodealliance/jco`
// Preview-1→Preview-2 adapter (`wasm-tools component new` under the hood).
//
// The adapter wraps our existing, unchanged Preview-1 core module into a
// Preview-2 component whose `poll_oneoff`/`fd_read`/`clock_time_get` are backed
// by the host's real `wasi:io/poll` + `wasi:clocks` + `wasi:io/streams`. NO
// codegen change — this is purely a build step that proves the reactor runs
// correctly under a genuine Preview-2 host (e.g. wasmtime 44's component model).
//
// Adapter shape: our reactor runs in `_start`, so the module is a WASI
// **command** → the `wasi_snapshot_preview1.command.wasm` adapter is required
// (the `.reactor.wasm` adapter is for library/reactor-export shapes and would
// fail to instantiate a `_start`-driven module).
//
// CLI:  node scripts/wasi-p2-component.mjs <core.wasm> [-o out.component.wasm] [--reactor]
// API:  import { resolveJco, adaptToPreview2Component } from "./wasi-p2-component.mjs";

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Resolve the installed `@bytecodealliance/jco` package programmatically.
 *
 * jco ships as a *transitive* dependency (via `componentize-js`) with no
 * top-level `node_modules/@bytecodealliance/jco` symlink and an `exports` map
 * that forbids the `./package.json` subpath, so `require.resolve(...)` does not
 * find it. We instead walk up from `startDir` looking for either a hoisted
 * layout or the pnpm virtual store (`node_modules/.pnpm/@bytecodealliance+jco@*`).
 *
 * @param {string} [startDir] directory to begin the upward search (default: this file's dir)
 * @returns {{ cli: string, adapterCommand: string, adapterReactor: string, dir: string } | null}
 */
export function resolveJco(startDir = dirname(fileURLToPath(import.meta.url))) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    // Hoisted / plain layout.
    const plain = join(dir, "node_modules", "@bytecodealliance", "jco");
    if (existsSync(join(plain, "lib", "wasi_snapshot_preview1.command.wasm"))) {
      return jcoPaths(plain);
    }
    // pnpm virtual store.
    const pnpmDir = join(dir, "node_modules", ".pnpm");
    if (existsSync(pnpmDir)) {
      const entries = readdirSync(pnpmDir)
        .filter((e) => e.startsWith("@bytecodealliance+jco@"))
        .sort()
        .reverse(); // prefer the highest version directory
      for (const e of entries) {
        const base = join(pnpmDir, e, "node_modules", "@bytecodealliance", "jco");
        if (existsSync(join(base, "lib", "wasi_snapshot_preview1.command.wasm"))) {
          return jcoPaths(base);
        }
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function jcoPaths(base) {
  return {
    dir: base,
    cli: join(base, "src", "jco.js"),
    adapterCommand: join(base, "lib", "wasi_snapshot_preview1.command.wasm"),
    adapterReactor: join(base, "lib", "wasi_snapshot_preview1.reactor.wasm"),
  };
}

/**
 * Adapt a Preview-1 core `.wasm` into a Preview-2 component on disk.
 *
 * @param {string} corePath   path to the compiled `--target wasi` core module
 * @param {string} outPath    path to write the produced component
 * @param {object} [opts]
 * @param {"command"|"reactor"} [opts.shape="command"]  adapter shape (`_start` ⇒ command)
 * @param {ReturnType<typeof resolveJco>} [opts.jco]    pre-resolved jco paths
 * @returns {string} outPath
 */
export function adaptToPreview2Component(corePath, outPath, opts = {}) {
  const shape = opts.shape ?? "command";
  const jco = opts.jco ?? resolveJco();
  if (!jco) {
    throw new Error(
      "@bytecodealliance/jco adapter not found — cannot build a Preview-2 component. " +
        "Ensure dependencies are installed (pnpm install).",
    );
  }
  const adapter = shape === "reactor" ? jco.adapterReactor : jco.adapterCommand;
  if (!existsSync(adapter)) {
    throw new Error(`jco ${shape} adapter wasm missing at ${adapter}`);
  }
  // `jco new <core> --adapt wasi_snapshot_preview1=<adapter> -o <out>`
  // (equivalent to `wasm-tools component new`, which jco vendors).
  execFileSync("node", [jco.cli, "new", corePath, "--adapt", `wasi_snapshot_preview1=${adapter}`, "-o", outPath], {
    stdio: "inherit",
  });
  return outPath;
}

// CLI entrypoint.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const core = args.find((a) => !a.startsWith("-"));
  const oIdx = args.indexOf("-o");
  const out = oIdx >= 0 ? args[oIdx + 1] : core?.replace(/\.wasm$/, "") + ".component.wasm";
  const shape = args.includes("--reactor") ? "reactor" : "command";
  if (!core) {
    console.error("usage: node scripts/wasi-p2-component.mjs <core.wasm> [-o out.component.wasm] [--reactor]");
    process.exit(2);
  }
  adaptToPreview2Component(core, out, { shape });
  console.log(`wrote Preview-2 component: ${out}`);
}
