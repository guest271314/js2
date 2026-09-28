// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster B, slice B10) test262 rows closed by B10. The inline programs
 * live in `issue-6651-b10-regexp-untyped-receiver-inline.test.ts` (split so one
 * vitest fork never holds both).
 *
 * Every row below fails on the pre-B10 tree. Each one reads a RegExp that
 * came back from `eval` — an `any` binding — and asserts
 * `Object.getPrototypeOf(result) === RegExp.prototype` (answered `null`: the
 * `__getPrototypeOf` native had no `$NativeRegExp` arm) and
 * `result.toString() === '/1/…'` (answered `"null"`: `__extern_get` found
 * `Object.prototype.toString` before `RegExp.prototype.toString`, and the
 * reified `RegExp.prototype.toString` closure body was a null placeholder).
 * See `src/codegen/regexp-untyped-receiver.ts` / `regexp-proto-to-string.ts`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = fileURLToPath(new URL("../test262/", import.meta.url));

const EXACT_ROWS = [
  "language/statementList/eval-block-regexp-literal.js",
  "language/statementList/eval-block-regexp-literal-flags.js",
  "language/statementList/eval-class-regexp-literal.js",
  "language/statementList/eval-class-regexp-literal-flags.js",
  "language/statementList/eval-fn-regexp-literal.js",
  "language/statementList/eval-fn-regexp-literal-flags.js",
] as const;

const TEST262_AVAILABLE =
  process.env.JS2_TEST262_AVAILABLE !== "0" &&
  existsSync(join(TEST262_ROOT, "harness", "assert.js")) &&
  EXACT_ROWS.every((relativePath) => existsSync(join(TEST262_ROOT, "test", relativePath)));
const itWithTest262 = TEST262_AVAILABLE ? it : it.skip;

async function runExactRow(relativePath: (typeof EXACT_ROWS)[number]) {
  try {
    return await runTest262File(
      join(TEST262_ROOT, "test", relativePath),
      "issue-6651-cluster-b10",
      180_000,
      "standalone",
    );
  } finally {
    restoreHostBuiltins();
  }
}

describe("#6651 B10 — test262 rows: an eval-produced (untyped) RegExp", () => {
  for (const relativePath of EXACT_ROWS) {
    itWithTest262(
      `test262 standalone: ${relativePath}`,
      async () => {
        const result = await runExactRow(relativePath);
        expect(`${relativePath}: ${result.status}`).toBe(`${relativePath}: pass`);
      },
      200_000,
    );
  }
});
