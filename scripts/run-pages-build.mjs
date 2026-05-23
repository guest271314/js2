#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

function run(command, args) {
  execFileSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
  });
}

const hasPlanningArtifacts =
  existsSync(resolve(ROOT, "plan")) &&
  existsSync(resolve(ROOT, "dashboard")) &&
  existsSync(resolve(ROOT, "scripts", "sprint-stats.ts")) &&
  existsSync(resolve(ROOT, "scripts", "build-planning-artifacts.mjs"));

if (hasPlanningArtifacts) {
  run(process.execPath, ["--experimental-strip-types", "scripts/sprint-stats.ts"]);
  run("node", ["scripts/build-planning-artifacts.mjs"]);
}

run(process.execPath, ["--experimental-strip-types", "scripts/generate-editions.ts"]);
run("pnpm", ["run", "build:playground"]);
run("pnpm", ["run", "build:compiler-bundle"]);
// --experimental-wasm-stringref is required because generate-size-benchmarks
// instantiates wasm modules that may use stringview_wtf16 (e.g. when the
// compiler emits wasm:js-string ops). Without the flag, Node 22+ rejects
// the module at compile-time with "invalid heap type 'stringview_wtf16'".
run(process.execPath, [
  "--experimental-strip-types",
  "--experimental-wasm-stringref",
  "scripts/generate-size-benchmarks.ts",
]);
run("node", ["scripts/build-pages.js"]);
