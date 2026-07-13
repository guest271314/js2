// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3109 — shared compile-and-run test harness.
 *
 * `tests/` re-declares a local `async function compileAndRun(source: string)`
 * in 130+ files across 10+ divergent signatures. This module extracts the
 * highest-duplication *identical-body* clusters ONCE so the copies can be
 * deleted.
 *
 * These are deliberately THREE distinct helpers, not one merged shape: the
 * clusters differ in how they wire host imports, and merging them would change
 * runtime behavior for the migrated tests (e.g. bare console-stub imports vs.
 * the full {@link buildImports} host object link different sets of imports).
 * Each function below is byte-for-byte behaviorally identical to the local copy
 * it replaces, so migration is a pure dedup with zero semantic drift. A test
 * whose local helper does something *extra* (custom import stubs, wasi knobs,
 * result-object shapes) is NOT a member of these clusters and keeps its local
 * helper.
 *
 * Import into a test file with an alias so the call sites stay unchanged, e.g.
 *   import { compileAndRunStubs as compileAndRun } from "./helpers/compile.js";
 */
import { expect } from "vitest";
import { compile } from "../../src/index.js";
import { buildImports } from "../../src/runtime.js";

/**
 * Cluster A (9 files): assert `result.success` (message includes the WAT), then
 * instantiate against bare no-op `env.console_log_*` stub imports and return the
 * exports. Used by tests whose compiled module only imports the console logging
 * builtins.
 */
export async function compileAndRunStubs(source: string): Promise<Record<string, Function>> {
  const result = await compile(source);
  expect(
    result.success,
    `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
  ).toBe(true);
  const imports = {
    env: {
      console_log_number: () => {},
      console_log_string: () => {},
      console_log_bool: () => {},
    },
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

/**
 * Cluster B (5 files): assert `result.success` (message without WAT), then
 * instantiate against the compiler-provided `result.importObject` and return the
 * exports.
 */
export async function compileAndRunImportObject(source: string): Promise<Record<string, Function>> {
  const result = await compile(source);
  expect(result.success, `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`).toBe(
    true,
  );
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject!);
  return instance.exports as Record<string, Function>;
}

/**
 * Cluster C (5 files): guard on a non-empty `result.binary` (throwing on failure
 * rather than asserting `result.success`), then instantiate against the full
 * {@link buildImports} host object and return the exports. Compiles with
 * `{ fileName: "test.ts" }`.
 */
export async function compileAndRunBuildImports(source: string): Promise<Record<string, Function>> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.binary || result.binary.length === 0) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}
