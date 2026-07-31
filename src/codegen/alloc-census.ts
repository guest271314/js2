// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3921) Per-type WasmGC allocation census — instrumentation only, OFF unless
 * `JS2WASM_ALLOC_CENSUS=1`.
 *
 * #3780 round 4 established that allocation volume is a first-class cost in the
 * standalone lane: the acorn self-parse allocates ~43.6 MB per 226 KB source
 * and only ~10 MB of that is the AST it returns. The other ~34 MB — roughly
 * 810 bytes per token — could not be attributed, because nothing available
 * observes WasmGC allocation:
 *
 *  - V8's sampling heap profiler does not see `struct.new` (measured: 0.2 MB
 *    sampled across a 58 MB parse, all of it on one `js-to-wasm` frame);
 *  - `--trace-gc-object-stats` is unavailable on the Node build in use;
 *  - a heap snapshot cannot be taken mid-parse — the benchmark export is one
 *    synchronous call and the AST is unreachable by the time it returns;
 *  - static `struct.new` SITE counts say where allocation can happen, not how
 *    often, and reading them as volume is the extrapolation trap #3684 caught.
 *
 * So the count has to come from the emitter. After each allocation this appends
 * a **stack-neutral** `global.get / i32.const 1 / i32.add / global.set`, which
 * leaves the freshly-allocated reference exactly where it was — no body needs
 * restructuring and no type changes.
 *
 * One exported mutable `i32` global per allocated type, named after the type
 * rather than its index: `wasm-opt` renumbers types, so a `typeIdx`-keyed
 * reader would go stale, while export names survive. A companion export carries
 * the count so a reader can enumerate without guessing.
 *
 * The instrumented binary is slower and larger. That is fine — it is a
 * measurement build, and the quantity it measures is deterministic, so it does
 * not compete with the timing benchmarks.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { walkChildren } from "./walk-instructions.js";

/** Export-name prefix for a per-type counter. */
export const ALLOC_CENSUS_PREFIX = "__alloc_count_";

export function allocCensusEnabled(): boolean {
  return process.env.JS2WASM_ALLOC_CENSUS === "1";
}

/** The allocation opcodes worth counting — every WasmGC heap producer. */
const ALLOC_OPS = new Set([
  "struct.new",
  "struct.new_default",
  "array.new",
  "array.new_default",
  "array.new_fixed",
  "array.new_data",
  "array.new_elem",
]);

/**
 * A readable, collision-free export suffix for a type. Struct names are
 * preferred because they are what the reader wants to see; the index is
 * appended regardless so two types that share a registered name (or none) stay
 * distinguishable.
 */
function censusName(ctx: CodegenContext, typeIdx: number): string {
  const registered = ctx.typeIdxToStructName.get(typeIdx);
  const base = registered === undefined ? "type" : registered.replace(/[^A-Za-z0-9_]/g, "_");
  return `${ALLOC_CENSUS_PREFIX}${base}_${typeIdx}`;
}

/**
 * Install the census. Call AFTER dead-type elimination and the peephole pass,
 * so the `typeIdx` on each allocation is already the final one, and before the
 * emit. Adding globals is not adding imports, so this does not disturb the
 * frozen import index space.
 */
export function installAllocCensus(ctx: CodegenContext): void {
  if (!allocCensusEnabled()) return;

  // Pass 1 — which types are actually allocated anywhere. Allocating a global
  // per declared type would bloat a module whose type table is mostly cold.
  const allocated = new Set<number>();
  for (const fn of ctx.mod.functions) collectAllocatedTypes(fn.body, allocated);
  if (allocated.size === 0) return;

  // Pass 2 — one exported mutable counter per allocated type.
  const globalIdxByType = new Map<number, number>();
  for (const typeIdx of [...allocated].sort((a, b) => a - b)) {
    const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
    ctx.mod.globals.push({
      name: censusName(ctx, typeIdx),
      type: { kind: "i32" },
      mutable: true,
      init: [{ op: "i32.const", value: 0 }],
    });
    ctx.mod.exports.push({ name: censusName(ctx, typeIdx), desc: { kind: "global", index: globalIdx } });
    globalIdxByType.set(typeIdx, globalIdx);
  }

  // Pass 3 — splice the increments in.
  for (const fn of ctx.mod.functions) instrumentBody(fn.body, globalIdxByType);
}

/** Every nested instruction array reachable from `instrs`, including itself. */
function everyArray(instrs: Instr[]): Instr[][] {
  const out: Instr[][] = [];
  const stack: Instr[][] = [instrs];
  while (stack.length > 0) {
    const arr = stack.pop()!;
    out.push(arr);
    for (const instr of arr) walkChildren(instr, (child) => stack.push(child));
  }
  return out;
}

function collectAllocatedTypes(instrs: Instr[], out: Set<number>): void {
  for (const arr of everyArray(instrs)) {
    for (const instr of arr) {
      const typeIdx = (instr as { op: string; typeIdx?: number }).typeIdx;
      if (ALLOC_OPS.has(instr.op) && typeof typeIdx === "number") out.add(typeIdx);
    }
  }
}

function instrumentBody(instrs: Instr[], globalIdxByType: ReadonlyMap<number, number>): void {
  // Collect the arrays FIRST, then rewrite: splicing while walking would make
  // the walk revisit the instructions it just inserted.
  for (const arr of everyArray(instrs)) {
    let hit = false;
    for (const instr of arr) {
      if (ALLOC_OPS.has(instr.op) && globalIdxByType.has((instr as { typeIdx?: number }).typeIdx ?? -1)) {
        hit = true;
        break;
      }
    }
    if (!hit) continue;
    const rewritten: Instr[] = [];
    for (const instr of arr) {
      rewritten.push(instr);
      const typeIdx = (instr as { typeIdx?: number }).typeIdx;
      if (!ALLOC_OPS.has(instr.op) || typeIdx === undefined) continue;
      const globalIdx = globalIdxByType.get(typeIdx);
      if (globalIdx === undefined) continue;
      rewritten.push(
        { op: "global.get", index: globalIdx },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "global.set", index: globalIdx },
      );
    }
    arr.splice(0, arr.length, ...rewritten);
  }
}
