// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Direct-verdict adapter for test262.fyi's external engine runner. The external
// project owns source assembly; js2 owns compilation, isolation, execution and
// verdict classification so published results cannot drift through stdout
// heuristics.
import { discoverFixtureGraph } from "./test262-fixture-graph.mjs";
import { FyiSourceExecutor, runTest } from "./run-test262-fyi.mjs";

const SUPPORTED_TARGETS = new Set(["gc", "standalone"]);

export class Test262FyiEngineAdapter {
  constructor({ target, test262Root, timeoutMs, execPath } = {}) {
    if (!SUPPORTED_TARGETS.has(target)) {
      throw new Error("test262.fyi engine target must be gc or standalone");
    }
    if (typeof test262Root !== "string" || test262Root.length === 0) {
      throw new Error("test262.fyi engine adapter requires test262Root");
    }

    this.target = target;
    this.test262Root = test262Root;
    this.executor = new FyiSourceExecutor(timeoutMs, { execPath });
  }

  async run(test) {
    if (!test || typeof test.file !== "string" || typeof test.contents !== "string") {
      throw new Error("test262.fyi engine adapter requires a complete test record");
    }

    const graph = discoverFixtureGraph(test.file, test.contents, { test262Root: this.test262Root });
    return runTest({ ...test, ...graph }, this.target, this.executor);
  }

  shutdown() {
    this.executor.shutdown();
  }
}
