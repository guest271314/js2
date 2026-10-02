// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6790 — runtime state that has to belong to one instance was kept per process.
//
// 1. The Node eval Worker kept every object it ever handed to the host, in both
//    threads, until `terminate()`.
// 2. (class-parent registry — see the second describe block)
// 3. (linked-provider registry — see the third describe block)

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type NodeEvalWorkerEvaluator, connectNodeEvalWorker } from "../src/runtime-node-eval-worker.js";

setFlagsFromString("--expose-gc");
const hostGc = runInNewContext("gc") as () => void;

/** Collect on the host and let the FinalizationRegistry callbacks run. */
async function settleHost(): Promise<void> {
  for (let round = 0; round < 4; round++) {
    hostGc();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("#6790 part 1 — the Node eval Worker releases handles the host dropped", () => {
  let workerBuildDir: string;
  let workerEntryUrl: URL;
  let evaluator: NodeEvalWorkerEvaluator | undefined;
  const indirect = { direct: false } as const;

  beforeAll(async () => {
    const temporaryRoot = join(process.cwd(), ".tmp");
    await mkdir(temporaryRoot, { recursive: true });
    workerBuildDir = await mkdtemp(join(temporaryRoot, "eval-worker-6790-"));
    const outfile = join(workerBuildDir, "worker.mjs");
    await build({
      entryPoints: [fileURLToPath(new URL("./fixtures/node-eval-worker.mjs", import.meta.url))],
      bundle: true,
      platform: "node",
      format: "esm",
      packages: "external",
      outfile,
    });
    workerEntryUrl = pathToFileURL(outfile);
    evaluator = await connectNodeEvalWorker(new Worker(workerEntryUrl));
    // The Worker realm's own collector, reached without --expose-gc on the
    // Worker (execArgv rejects it): the flag is process-wide once set.
    evaluator.evaluate(
      "globalThis.__refs = []; process.getBuiltinModule('v8').setFlagsFromString('--expose-gc');" +
        " globalThis.__gc = process.getBuiltinModule('vm').runInNewContext('gc'); 0",
      indirect,
    );
  });

  afterAll(async () => {
    await evaluator?.terminate();
    await rm(workerBuildDir, { recursive: true, force: true });
  });

  /** Worker-realm objects minted by the loop below that are still alive. */
  const liveInWorker = (): number =>
    evaluator!.evaluate("__gc(); __refs.filter((ref) => ref.deref() !== undefined).length", indirect) as number;

  it('keeps 10,000 eval("({})") results bounded in both realms', async () => {
    const hostRefs: WeakRef<object>[] = [];
    let peakInWorker = 0;
    for (let chunk = 0; chunk < 10; chunk++) {
      for (let i = 0; i < 1_000; i++) {
        const proxy = evaluator!.evaluate(
          "(() => { const o = {}; __refs.push(new WeakRef(o)); return o; })()",
          indirect,
        ) as object;
        hostRefs.push(new WeakRef(proxy));
      }
      // A real host yields to its event loop between bursts; that is where the
      // releases are produced. Before #6790 this count only ever grew.
      await settleHost();
      peakInWorker = Math.max(peakInWorker, liveInWorker());
    }
    expect(hostRefs.length).toBe(10_000);
    // A single straggler (the newest proxy can sit in a register) is fine; the
    // pre-fix value was 10,000 in each realm.
    expect(hostRefs.filter((ref) => ref.deref() !== undefined).length).toBeLessThan(10);
    expect(liveInWorker()).toBeLessThan(10);
    expect(peakInWorker).toBeLessThan(1_000 + 10);
  }, 120_000);

  it("re-mints a released object under a fresh handle instead of a dead one", async () => {
    evaluator!.evaluate("globalThis.__kept = { n: 7 }; 0", indirect);
    const read = (): unknown => (evaluator!.evaluate("__kept", indirect) as { n: unknown }).n;
    expect(read()).toBe(7);
    await settleHost();
    // The first proxy is gone and its handle released; the same Worker object
    // must come back usable, which it cannot if the Worker still maps it to
    // the released id.
    evaluator!.evaluate("0", indirect);
    expect(read()).toBe(7);
  });

  it("never releases a handle the host still holds", async () => {
    const held = evaluator!.evaluate("({ n: 41, inc() { return ++this.n; } })", indirect) as {
      n: number;
      inc(): number;
    };
    for (let i = 0; i < 200; i++) evaluator!.evaluate("({})", indirect);
    await settleHost();
    evaluator!.evaluate("0", indirect);
    expect(held.inc()).toBe(42);
    expect(held.n).toBe(42);
  });
});
