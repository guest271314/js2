// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6790 — runtime state that has to belong to one instance was kept per process.
//
// 1. The Node eval Worker kept every object it ever handed to the host, in both
//    threads, until `terminate()`.
// 2. The dynamic class-parent registry (`class C extends <value>`) was one
//    process-wide table keyed by class NAME, so two live instances that each
//    declared a `C` with a different parent shared one entry.
// 3. (linked-provider registry — see the third describe block)

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { Worker } from "node:worker_threads";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { type NodeEvalWorkerEvaluator, connectNodeEvalWorker } from "../src/runtime-node-eval-worker.js";
import { buildImports } from "../src/runtime.js";

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

describe("#6790 part 2 — class parents are registered per instance, not per class name", () => {
  /** A host constructor that stamps who constructed the receiver, with a static of the same label. */
  function makeBase(label: string, log: string[]): Function {
    const Base = function (this: Record<string, unknown>) {
      log.push(label);
      this.tag = label;
    } as unknown as Function & { who?: string };
    Base.who = label;
    return Base;
  }

  /** Instantiate one compiled binary with the host value its heritage reads at init. */
  async function instantiateWith(
    result: Awaited<ReturnType<typeof compile>>,
    slot: string,
    value: unknown,
  ): Promise<Record<string, () => unknown>> {
    (globalThis as Record<string, unknown>)[slot] = value;
    try {
      const imports = buildImports(result.imports, undefined, result.stringPool);
      const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
      imports.setInstance?.(instance);
      return instance.exports as unknown as Record<string, () => unknown>;
    } finally {
      delete (globalThis as Record<string, unknown>)[slot];
    }
  }

  it("each instance's SuperCall runs its own parent (property-access heritage)", async () => {
    const slot = "__issue6790_ns";
    const result = await compile(
      `
        const NS: any = (globalThis as any).${slot};
        class C extends NS.Base {
          constructor() { super(); }
        }
        export function tag(): any { const c: any = new C(); return c.tag; }
        export function staticWho(): any { return (C as any).who; }
      `,
      { fileName: "issue-6790-a.ts", skipSemanticDiagnostics: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    // The heritage this test is about: resolved by NAME at the SuperCall.
    expect(result.imports.some((d) => d.name.startsWith("__call_dynamic_class_parent_"))).toBe(true);

    const log: string[] = [];
    const a = await instantiateWith(result, slot, { Base: makeBase("A", log) });
    const b = await instantiateWith(result, slot, { Base: makeBase("B", log) });

    // Before #6790 the second registration overwrote the first: A's `new C()`
    // ran B's constructor (tag "B", log ["B"]) and `C.who` read "B".
    log.length = 0;
    expect(a.tag!()).toBe("A");
    expect(log).toEqual(["A"]);
    log.length = 0;
    expect(b.tag!()).toBe("B");
    expect(log).toEqual(["B"]);
    expect(a.staticWho!()).toBe("A");
    expect(b.staticWho!()).toBe("B");
  }, 120_000);

  it("two different programs declaring the same class name keep their own static parents", async () => {
    const slotA = "__issue6790_baseA";
    const slotB = "__issue6790_baseB";
    const program = (slot: string, extra: string) =>
      compile(
        `
          const P: any = (globalThis as any).${slot};
          class C extends P {
            constructor() { super(); }
          }
          export function staticWho(): any { return (C as any).who; }
          export function ${extra}(): number { return 1; }
        `,
        { fileName: `issue-6790-${extra}.ts`, skipSemanticDiagnostics: true },
      );
    const [first, second] = await Promise.all([program(slotA, "first"), program(slotB, "second")]);
    expect(first.success && second.success).toBe(true);
    expect(first.imports.some((d) => d.name === "__register_class_parent")).toBe(true);

    const log: string[] = [];
    const a = await instantiateWith(first, slotA, makeBase("A", log));
    const b = await instantiateWith(second, slotB, makeBase("B", log));
    expect(a.staticWho!()).toBe("A");
    expect(b.staticWho!()).toBe("B");
  }, 120_000);
});
