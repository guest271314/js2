// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #700 — the authoritative Test262 worker must use the persistent TypeScript
 * Language Service for literal JavaScript harness assemblies, not only for the
 * older synthetic-TypeScript lane.
 */
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { CompilerPool } from "../scripts/compiler-pool.js";
import { compile, createIncrementalCompiler } from "../src/index.js";
import { assembleOriginalHarness } from "./test262-original-harness.js";

const WORKER_OPTIONS = {
  allowJs: true,
  fileName: "test.js",
  sourceMap: true,
  sourceMapUrl: "test.wasm.map",
  emitWat: false,
  skipSemanticDiagnostics: true,
  deferTopLevelInit: true,
} as const;

let pool: CompilerPool | undefined;

afterAll(() => {
  pool?.shutdown();
});

describe("#700 Test262 Language Service integration", () => {
  it("routes the original-harness branch through the persistent single-source compiler", () => {
    const worker = readFileSync("scripts/test262-worker.mjs", "utf8");
    const branchStart = worker.indexOf("  if (originalHarness) {");
    const branchEnd = worker.indexOf("\n  }\n  return compileSingleSource(source, {", branchStart);
    const originalHarnessBranch = worker.slice(branchStart, branchEnd);

    expect(branchStart).toBeGreaterThan(-1);
    expect(branchEnd).toBeGreaterThan(branchStart);
    expect(originalHarnessBranch).toContain("return compileSingleSource(source, {");
    expect(originalHarnessBranch).not.toContain("return compile(source, {");
    expect(worker).toContain(
      "return incrementalCompiler ? incrementalCompiler.compile(source, options) : compile(source, options);",
    );
  });

  it("keeps sequential JavaScript harness replacements byte-identical to standalone compilation", async () => {
    const sources = [
      "assert.sameValue(21 * 2, 42);\n",
      "var values = [1, 2, 3];\nassert.sameValue(values.length, 3);\n",
      "var total = 0;\nfor (var i = 0; i < 8; i++) total += i;\nassert.sameValue(total, 28);\n",
    ].map((body) => assembleOriginalHarness(body, { flags: ["noStrict"] }).primary.source);
    const incremental = createIncrementalCompiler(WORKER_OPTIONS);

    try {
      for (const source of sources) {
        const standaloneResult = await compile(source, WORKER_OPTIONS);
        const incrementalResult = await incremental.compile(source);

        expect(incrementalResult.success).toBe(standaloneResult.success);
        expect(incrementalResult.errors).toEqual(standaloneResult.errors);
        expect(Buffer.from(incrementalResult.binary)).toEqual(Buffer.from(standaloneResult.binary));
      }
    } finally {
      incremental.dispose();
    }
  });

  it("drops syntax diagnostics from the preceding JavaScript harness", async () => {
    const precedingSource = assembleOriginalHarness(
      'if (1 !== undefined) throw new Test262Error("preceding runtime failure");\n',
      { flags: ["noStrict"] },
    ).primary.source;
    const invalidSource = assembleOriginalHarness("const = ;\n", { flags: ["noStrict"] }).primary.source;
    const validSource = assembleOriginalHarness('throw new SyntaxError("runtime, not parse");\n', {
      flags: ["noStrict"],
    }).primary.source;
    const incremental = createIncrementalCompiler(WORKER_OPTIONS);

    try {
      const precedingResult = await incremental.compile(precedingSource);
      expect(precedingResult.success).toBe(true);

      const invalidResult = await incremental.compile(invalidSource);
      expect(invalidResult.success).toBe(false);

      const standaloneResult = await compile(validSource, WORKER_OPTIONS);
      const incrementalResult = await incremental.compile(validSource);
      expect(standaloneResult.success).toBe(true);
      expect(incrementalResult.errors).toEqual(standaloneResult.errors);
      expect(incrementalResult.success).toBe(standaloneResult.success);
      expect(Buffer.from(incrementalResult.binary)).toEqual(Buffer.from(standaloneResult.binary));
    } finally {
      incremental.dispose();
    }
  });

  it("compiles and executes consecutive original-harness jobs in one unified CI worker", async () => {
    pool = new CompilerPool(1, "unified");
    await pool.ready();

    const bodies = [
      "assert.sameValue(6 * 7, 42);\n",
      "assert.sameValue([1, 2, 3].length, 3);\n",
      "var value = 0;\nfor (var i = 0; i < 5; i++) value += i;\nassert.sameValue(value, 10);\n",
    ];
    const sources = bodies.map((body) => assembleOriginalHarness(body, { flags: ["noStrict"] }).primary.source);

    for (const [index, source] of sources.entries()) {
      const result = await pool.runTest(
        source,
        {
          originalHarness: true,
          asyncTest: false,
          inferModuleStrictArguments: false,
          label: `#700 original-harness incremental job ${index + 1}`,
        },
        30_000,
      );
      expect(result.status, result.error).toBe("pass");
      expect(result.reachedTest).toBe(true);
    }

    const invalidSource = assembleOriginalHarness("const = ;\n", { flags: ["noStrict"] }).primary.source;
    const invalidResult = await pool.runTest(
      invalidSource,
      {
        originalHarness: true,
        isRuntimeNegative: true,
        expectedErrorType: "TypeError",
        label: "#700 invalid original-harness source",
      },
      30_000,
    );
    expect(invalidResult.status, JSON.stringify(invalidResult)).toBe("compile_error");

    const recoveredSource = assembleOriginalHarness("assert.sameValue(2 + 2, 4);\n", {
      flags: ["noStrict"],
    }).primary.source;
    const recoveredResult = await pool.runTest(
      recoveredSource,
      {
        originalHarness: true,
        label: "#700 passing original-harness source after syntax error",
      },
      30_000,
    );
    expect(recoveredResult.status, JSON.stringify(recoveredResult)).toBe("pass");
    expect(recoveredResult.reachedTest).toBe(true);

    const standaloneResult = await pool.runTest(
      recoveredSource,
      {
        originalHarness: true,
        target: "standalone",
        label: "#700 standalone original-harness source",
      },
      30_000,
    );
    expect(standaloneResult.status, JSON.stringify(standaloneResult)).toBe("pass");
    expect(standaloneResult.reachedTest).toBe(true);
  }, 90_000);
});
