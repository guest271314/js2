// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALLOCATION_POLICY_SHAPE,
  buildAllocationPolicyProof,
  LINEAR_ALLOCATION_POLICY_SOURCE,
} from "../benchmarks/allocation-policy-proof.js";
import { compile } from "../src/index.js";
import {
  ANALYSIS_STACK_ARENA_POLICY,
  DEFAULT_ARENA_POLICY,
  planLinearMemory,
  type LinearAllocationSitePlan,
} from "../src/ir/analysis/linear-memory-plan.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { PORFFOR_KIND_NAMES, porfforRendererOutputText, type PorfforNode } from "../src/ir/backend/porffor/compat.js";
import { lowerIrModuleToPorffor } from "../src/ir/backend/porffor/integration.js";
import { loadOptionalPorffor } from "../src/ir/backend/porffor/loader.js";
import { verifyIrBackendLegality } from "../src/ir/backend/legality.js";
import { verifyIrFunction } from "../src/ir/verify.js";

const here = dirname(fileURLToPath(import.meta.url));
const porfforRoot = process.env.JS2WASM_PORFFOR_ROOT ?? join(here, "../vendor/Porffor");

function decisionNeutral(allocation: LinearAllocationSitePlan) {
  const {
    allocationClass: _allocationClass,
    lifetime: _lifetime,
    root: _root,
    safepoints: _safepoints,
    barrier: _barrier,
    operations: _operations,
    ...facts
  } = allocation;
  return facts;
}

function collectNodes(value: unknown, out: PorfforNode[] = []): PorfforNode[] {
  if (!Array.isArray(value)) return out;
  if (value.length === 6 && typeof value[0] === "number" && PORFFOR_KIND_NAMES[value[0]]) {
    const node = value as unknown as PorfforNode;
    out.push(node);
    collectNodes(node[3], out);
    collectNodes(node[4], out);
    collectNodes(node[5], out);
    return out;
  }
  for (const item of value) collectNodes(item, out);
  return out;
}

function nodeName(node: PorfforNode): string {
  return PORFFOR_KIND_NAMES[node[0]]!;
}

describe("#3300 shared allocation-policy proof", () => {
  it("changes decisions without changing allocation facts, layouts, pointer maps, or ABI provenance", () => {
    const fixture = buildAllocationPolicyProof();
    for (const func of fixture.module.functions) {
      expect(verifyIrFunction(func)).toEqual([]);
      expect(verifyIrBackendLegality(func, "linear")).toEqual([]);
      expect(verifyIrBackendLegality(func, "porffor")).toEqual([]);
    }

    const arena = planLinearMemory(fixture.module, fixture.registry, DEFAULT_ARENA_POLICY);
    const stack = planLinearMemory(fixture.module, fixture.registry, ANALYSIS_STACK_ARENA_POLICY);

    expect(stack.layouts).toEqual(arena.layouts);
    expect(stack.dataSegments).toEqual(arena.dataSegments);
    expect(stack.globals).toEqual(arena.globals);
    expect(stack.allocations.map(decisionNeutral)).toEqual(arena.allocations.map(decisionNeutral));
    expect(stack.layoutForObjectShape(ALLOCATION_POLICY_SHAPE)?.pointerMap).toEqual(
      arena.layoutForObjectShape(ALLOCATION_POLICY_SHAPE)?.pointerMap,
    );

    const objectSites = stack.allocations.filter((allocation) => allocation.ownerFunction === "objectPolicyProof");
    expect(objectSites).toHaveLength(2);
    expect(
      objectSites.every(
        (allocation) =>
          allocation.allocationClass === "stack" &&
          allocation.escape === "local" &&
          allocation.stackCandidate &&
          allocation.root.kind === "none" &&
          allocation.barrier.kind === "none" &&
          allocation.operations.some((operation) => operation.family === "stack" && operation.operation === "mark") &&
          allocation.operations.some((operation) => operation.family === "stack" && operation.operation === "restore"),
      ),
    ).toBe(true);

    const vectorSite = stack.allocations.find((allocation) => allocation.ownerFunction === "vectorPolicyProof");
    expect(vectorSite).toMatchObject({ allocationClass: "arena", stackCandidate: false });
    expect(arena.allocations.every((allocation) => allocation.allocationClass === "arena")).toBe(true);
  });

  it("reclaims promoted linear-Wasm sites per invocation while preserving alias and identity", async () => {
    const baseline = await compile(LINEAR_ALLOCATION_POLICY_SOURCE, { target: "linear", allocator: "bump" });
    expect(baseline.success, baseline.errors.map((error) => error.message).join("; ")).toBe(true);
    const baselinePlan = getLastLinearIrReport()?.memoryPlan;
    expect(baselinePlan?.policy).toBe("arena-v1");

    const promoted = await compile(LINEAR_ALLOCATION_POLICY_SOURCE, {
      target: "linear",
      allocator: "analysis-stack",
    });
    expect(promoted.success, promoted.errors.map((error) => error.message).join("; ")).toBe(true);
    const promotedPlan = getLastLinearIrReport()?.memoryPlan;
    expect(promotedPlan?.policy).toBe("analysis-stack-arena-v1");
    expect(promotedPlan?.allocations.every((allocation) => allocation.allocationClass === "stack")).toBe(true);

    const baselineInstance = (await WebAssembly.instantiate(baseline.binary!)).instance;
    const promotedInstance = (await WebAssembly.instantiate(promoted.binary!)).instance;
    const baselineExports = baselineInstance.exports as unknown as {
      objectPolicyProof(seed: number): number;
      memory: WebAssembly.Memory;
    };
    const promotedExports = promotedInstance.exports as typeof baselineExports;
    for (let index = 0; index < 10_000; index++) {
      expect(baselineExports.objectPolicyProof(index)).toBe(index + 7);
      expect(promotedExports.objectPolicyProof(index)).toBe(index + 7);
    }
    expect(baselineExports.memory.buffer.byteLength).toBeGreaterThan(promotedExports.memory.buffer.byteLength);
    expect(promotedExports.memory.buffer.byteLength).toBe(2 * 65_536);

    const overflowStress = await compile(
      `export function frameStress(count: number): number {
        let sum = 0;
        for (let i = 0; i < count; i++) {
          const value = { x: i };
          sum = sum + value.x;
        }
        return sum;
      }`,
      { target: "linear", allocator: "analysis-stack" },
    );
    expect(overflowStress.success, overflowStress.errors.map((error) => error.message).join("; ")).toBe(true);
    expect(getLastLinearIrReport()?.memoryPlan.allocations[0]).toMatchObject({ allocationClass: "stack" });
    const overflowInstance = (await WebAssembly.instantiate(overflowStress.binary!)).instance;
    const overflowExports = overflowInstance.exports as unknown as {
      frameStress(count: number): number;
      memory: WebAssembly.Memory;
    };
    expect(overflowExports.frameStress(10_000)).toBe(49_995_000);
    expect(overflowExports.memory.buffer.byteLength).toBeGreaterThan(2 * 65_536);
  }, 60_000);

  const optionalIt = findCCompiler() ? it : it.skip;
  optionalIt(
    "executes stack promotion plus arena fallback through Porffor-C without semantic-layout operations",
    async () => {
      const fixture = buildAllocationPolicyProof();
      const plan = planLinearMemory(fixture.module, fixture.registry, ANALYSIS_STACK_ARENA_POLICY);
      const input = lowerIrModuleToPorffor(fixture.module, { memoryPlan: plan });
      const objectFunc = input.funcs.find((func) => func?.name === "objectPolicyProof")!;
      const objectNodes = collectNodes(objectFunc.body);
      const calls = objectNodes.filter((node) => nodeName(node) === "Call").map((node) => node[3]);
      expect(calls.filter((target) => target === "#js2_stack_allocate")).toHaveLength(2);
      expect(calls).toContain("#js2_stack_mark");
      expect(calls).toContain("#js2_stack_restore");
      expect(objectNodes.map(nodeName)).not.toContain("Alloc");

      const vectorFunc = input.funcs.find((func) => func?.name === "vectorPolicyProof")!;
      expect(collectNodes(vectorFunc.body).map(nodeName)).toContain("Alloc");
      expect(input.prefs.gc).toBe(false);
      for (const forbidden of ["GcBarrier", "ArrGet", "ArrSet", "LenGet", "LenSet", "RawC"] as const) {
        expect(objectNodes.map(nodeName)).not.toContain(forbidden);
      }

      const porffor = await loadOptionalPorffor({ root: porfforRoot });
      const rendered = porfforRendererOutputText(porffor.render(input));
      const values = compileAndRunC(rendered, input.funcs, [
        { name: "objectPolicyProof", args: [4] },
        { name: "objectPolicyProof", args: [7] },
        { name: "vectorPolicyProof", args: [1] },
        { name: "vectorPolicyProof", args: [-1] },
        { name: "vectorPolicyProof", args: [8] },
      ]);
      expect(values).toEqual([911, 911, 309, 300, 300]);
    },
    60_000,
  );
});

function findCCompiler(): string | null {
  for (const candidate of [process.env.CC, "cc", "clang", "gcc"].filter((value): value is string => !!value)) {
    if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) return candidate;
  }
  return null;
}

function compileAndRunC(
  rendered: string,
  funcs: readonly ({ readonly name: string; readonly index: number } | null | undefined)[],
  calls: readonly { readonly name: string; readonly args: readonly number[] }[],
): number[] {
  const compiler = findCCompiler();
  if (!compiler) throw new Error("no C compiler available");
  const symbols = new Map(
    funcs.filter((func): func is NonNullable<typeof func> => !!func).map((func) => [func.name, func]),
  );
  const invocationLines = calls.map((call) => {
    const func = symbols.get(call.name);
    if (!func) throw new Error(`missing Porffor function ${call.name}`);
    return `  printf("%.17g\\n", p${func.index}_${func.name}(${call.args.join(", ")}));`;
  });
  const harness = `
int main(int argc, char** argv) {
  porf_init(argc, argv);
  porf_data_init();
${invocationLines.join("\n")}
  return 0;
}
`;
  const directory = mkdtempSync(join(tmpdir(), "js2-porffor-3300-"));
  const sourcePath = join(directory, "proof.c");
  const binaryPath = join(directory, "proof");
  try {
    writeFileSync(sourcePath, rendered + harness);
    const result = spawnSync(
      compiler,
      ["-std=gnu11", "-Werror", "-Wno-unused-function", sourcePath, "-lm", "-o", binaryPath],
      { encoding: "utf8" },
    );
    expect(result.status, `C compiler failed:\n${result.stdout}\n${result.stderr}`).toBe(0);
    return execFileSync(binaryPath, { encoding: "utf8" }).trim().split("\n").map(Number);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
