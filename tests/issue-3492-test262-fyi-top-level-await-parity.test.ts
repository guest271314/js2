// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest } from "../scripts/run-test262-fyi.mjs";
import {
  discoverFixtureGraph,
  dynamicFixtureSpecifiers,
  staticFixtureSpecifiers,
} from "../scripts/test262-fixture-graph.mjs";
import { loadOriginalHarnessTests } from "../scripts/test262-fyi-reader.mjs";

const TEST_ROOT = join(import.meta.dirname, "..", "test262", "test");
const DYNAMIC_TLA_PATH = "language/module-code/top-level-await/module-graphs-does-not-hang.js";
const PENDING_CYCLE_PATH = "language/module-code/top-level-await/pending-async-dep-from-cycle.js";

function upstreamSource(path: string): string {
  return readFileSync(join(TEST_ROOT, path), "utf8");
}

describe("#3492 — honest Test262 fixture graph parity", () => {
  it("recognizes bare side-effect imports and literal dynamic imports without reading examples", () => {
    const source = `
      /* import "./comment_FIXTURE.js"; */
      const example = \`import("./template_FIXTURE.js")\`;
      const name = "./computed_FIXTURE.js";
      import "./side-effect_FIXTURE.js";
      import value from "./binding_FIXTURE.js";
      await import("./dynamic_FIXTURE.js");
      await import(name);
    `;

    expect(staticFixtureSpecifiers(source)).toEqual(["./side-effect_FIXTURE.js", "./binding_FIXTURE.js"]);
    expect(dynamicFixtureSpecifiers(source)).toEqual(["./dynamic_FIXTURE.js"]);
  });

  it("discovers the complete static pending-cycle graph", () => {
    const graph = discoverFixtureGraph(PENDING_CYCLE_PATH, upstreamSource(PENDING_CYCLE_PATH));

    expect(Object.keys(graph.fixtureFiles)).toEqual([
      "./language/module-code/top-level-await/pending-async-dep-from-cycle_setup_FIXTURE.js",
      "./language/module-code/top-level-await/pending-async-dep-from-cycle_cycle-root_FIXTURE.js",
      "./language/module-code/top-level-await/pending-async-dep-from-cycle_cycle-leaf_FIXTURE.js",
      "./language/module-code/top-level-await/pending-async-dep-from-cycle_import-cycle-leaf_FIXTURE.js",
    ]);
    expect(graph.dynamicFixtureFiles).toEqual({});
  });

  it("keeps a literal dynamic dependency separate from eager static graph edges", () => {
    const graph = discoverFixtureGraph(DYNAMIC_TLA_PATH, upstreamSource(DYNAMIC_TLA_PATH));

    expect(Object.keys(graph.fixtureFiles)).toEqual([
      "./language/module-code/top-level-await/module-graphs-parent-tla_FIXTURE.js",
      "./language/module-code/top-level-await/tla_FIXTURE.js",
    ]);
    expect(Object.keys(graph.dynamicFixtureFiles)).toEqual([
      "./language/module-code/top-level-await/module-graphs-grandparent-tla_FIXTURE.js",
    ]);
  });

  it("executes a bare-import fixture side effect before accepting completion", { timeout: 60_000 }, async () => {
    const entryFile = "./language/module-code/top-level-await/fixture-side-effect-control.js";
    const fixtureFile = "./language/module-code/top-level-await/fixture-side-effect-control_FIXTURE.js";
    const result = await runTest(
      {
        file: entryFile.slice(2),
        entryFile,
        fixtureFiles: {
          [fixtureFile]: "export const fixtureSideEffect = 41;",
        },
        dynamicFixtureFiles: {},
        contents: `
          import { fixtureSideEffect } from "./fixture-side-effect-control_FIXTURE.js";
          if (fixtureSideEffect !== 41) throw new Error("fixture initialization was omitted");
        `,
        flags: { module: true },
        negative: undefined,
        strictRerun: false,
      },
      "standalone",
    );

    expect(result.pass, JSON.stringify(result)).toBe(true);
    expect(result).toMatchObject({ phase: "runtime", reachedTest: true });
  });

  it("reports the two historical project-only passes as honest unreached failures", { timeout: 60_000 }, async () => {
    const tests = await loadOriginalHarnessTests([DYNAMIC_TLA_PATH, PENDING_CYCLE_PATH]);
    const byPath = new Map(tests.map((test) => [test.file, test]));
    const [dynamic, cycle] = await Promise.all([
      runTest(byPath.get(DYNAMIC_TLA_PATH)!, "standalone"),
      runTest(byPath.get(PENDING_CYCLE_PATH)!, "standalone"),
    ]);

    expect(dynamic).toMatchObject({
      pass: false,
      phase: "compile",
      reachedTest: false,
      detail: "standalone literal dynamic fixture import is unsupported (#3494)",
    });
    expect(cycle).toMatchObject({
      pass: false,
      phase: "runtime",
      reachedTest: false,
    });
    expect(cycle.detail).toContain("illegal cast");
  });
});
