// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2140 — stack-balance fixBranchType: coerce-where-possible, throw on
 * impossible (staged: record-and-ratchet, strict-mode throw).
 *
 * The June audit's #1 finding: `fixBranchType` silently substituted
 * `drop; f64.const 0` for externref→f64 / ref→f64 branch mismatches while
 * the call-arg path correctly unboxed — a coercion's runtime value depended
 * on which syntactic context triggered it. #1917 Step 0 landed the shared
 * `coercionPlan` table and pointed fixBranchType at it; this issue closes
 * the residue:
 *
 *   1. standalone lane: `__box_number`/`__unbox_number` are DEFINED functions
 *      there (not env imports) — the import-only helper scan left the plan's
 *      box/unbox rows dead in exactly the host-less lane. Now scans defined
 *      functions too.
 *   2. `plan.lossy` propagates into the recorded FixupEvent (funcref→externref
 *      and no-helper unbox rows were mis-reported as clean).
 *   3. detected-but-unbridgeable mismatches (e.g. funcref→f64) record a
 *      `branch-type-unfixable` event (lossy) instead of silently leaving a
 *      module that fails WebAssembly.validate with an opaque offset — a hard
 *      compile error under JS2WASM_STRICT_BALANCE=error, pinned at 0 by the
 *      corpus ratchet.
 *   4. table extension: eqref/anyref → f64/i32 unbox rows (live in branch
 *      context for eqref, and in call-arg/local.set contexts — whose richer
 *      inferInstrType reads local types — for both).
 *
 * These are emitter-bug simulators, not reachable from clean TS source — so
 * the tests drive `stackBalance` directly on hand-built modules (the
 * issue-1918.test.ts pattern) and assert the appended instructions, the
 * recorded events, strict-mode diagnostics, and (where the module is
 * complete) WebAssembly.validate.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  getFixupEvents,
  stackBalance,
  strictBalanceDiagnostics,
  summarizeFixups,
} from "../src/codegen/stack-balance.js";
import { coercionPlan } from "../src/codegen/coercion-plan.js";
import { emitBinary } from "../src/emit/binary.js";
import type { Instr, WasmModule } from "../src/ir/types.js";

function emptyModule(): WasmModule {
  return {
    types: [],
    imports: [],
    functions: [],
    globals: [],
    exports: [],
    memories: [],
    tables: [],
    elements: [],
    dataSegments: [],
    tags: [],
    // (#1916 S3) required by buildFuncSigs' stable-handle alias loop.
    funcOrdinalToPosition: [],
    // required unconditionally by emitBinary's element-section emitter.
    declaredFuncRefs: [],
  } as unknown as WasmModule;
}

/** ()->f64 function whose body leaves a `ref.null.extern` — the AC#1 repro. */
function externToF64Module(unboxAs: "import" | "defined" | "absent"): WasmModule {
  const mod = emptyModule();
  // type 0: () -> f64 (the victim); type 1: (externref) -> f64 (the unbox helper)
  mod.types.push({ kind: "func", name: "$f", params: [], results: [{ kind: "f64" }] } as never);
  mod.types.push({
    kind: "func",
    name: "$unbox",
    params: [{ kind: "externref" }],
    results: [{ kind: "f64" }],
  } as never);
  if (unboxAs === "import") {
    mod.imports.push({ module: "env", name: "__unbox_number", desc: { kind: "func", typeIdx: 1 } } as never);
  } else if (unboxAs === "defined") {
    // Defined-function __unbox_number stub (the standalone shape): returns 42.
    // (The externref param is a LOCAL, not a stack operand — no drop needed.)
    mod.functions.push({
      name: "__unbox_number",
      typeIdx: 1,
      locals: [],
      body: [{ op: "f64.const", value: 42 }] as Instr[],
      exported: false,
    } as never);
  }
  mod.functions.push({
    name: "victim",
    typeIdx: 0,
    locals: [],
    // A val-typed block whose result is externref where f64 is expected.
    body: [
      {
        op: "block",
        blockType: { kind: "val", type: { kind: "f64" } },
        body: [{ op: "ref.null.extern" }] as Instr[],
      },
    ] as Instr[],
    exported: true,
  } as never);
  // Absolute func index of `victim`: "import" → 1 import + position 0 = 1;
  // "defined" → 0 imports + position 1 (after the stub) = 1; "absent" → 0.
  mod.exports.push({ name: "victim", desc: { kind: "func", index: unboxAs === "absent" ? 0 : 1 } } as never);
  return mod;
}

/** ()->f64 function whose body leaves a funcref — no coercion bridges this.
 *  Uses `ref.func` (self-referential) because `inferLastType` has no locals
 *  context — `local.get` is uninferable and would skip the fixup entirely. */
function funcrefToF64Module(): WasmModule {
  const mod = emptyModule();
  mod.types.push({ kind: "func", name: "$f", params: [], results: [{ kind: "f64" }] } as never);
  mod.functions.push({
    name: "victim",
    typeIdx: 0,
    locals: [],
    body: [
      {
        op: "block",
        blockType: { kind: "val", type: { kind: "f64" } },
        body: [{ op: "ref.func", funcIdx: 0 }] as unknown as Instr[],
      },
    ] as Instr[],
    exported: false,
  } as never);
  return mod;
}

function victimBlockBody(mod: WasmModule, funcIdx = 0): Instr[] {
  const block = (mod.functions[funcIdx]! as { body: Instr[] }).body[0] as unknown as { body: Instr[] };
  return block.body;
}

describe("#2140 fixBranchType — coerce arms via the shared coercionPlan", () => {
  afterEach(() => {
    Reflect.deleteProperty(process.env, "JS2WASM_STRICT_BALANCE");
  });

  it("AC#1 (host shape): externref→f64 branch result is UNBOXED via the imported __unbox_number, not zero-substituted", () => {
    const mod = externToF64Module("import");
    stackBalance(mod);
    const body = victimBlockBody(mod);
    // ref.null.extern ; call $__unbox_number  (import index 0)
    expect(body.map((i) => i.op)).toEqual(["ref.null.extern", "call"]);
    expect((body[1] as { funcIdx?: number }).funcIdx).toBe(0);
    // No drop / f64.const 0 substitution anywhere in the branch.
    expect(body.some((i) => i.op === "f64.const")).toBe(false);
    // The recorded event is a clean (non-lossy) coerce.
    const ev = getFixupEvents().find((e) => e.kind === "branch-type-coerce");
    expect(ev).toBeTruthy();
    expect(ev!.lossy).toBe(false);
    // The repaired module is valid Wasm.
    expect(WebAssembly.validate(emitBinary(mod))).toBe(true);
  });

  it("AC#1 (standalone shape): a DEFINED __unbox_number is found by the helper scan (#2140 lane fix)", async () => {
    const mod = externToF64Module("defined");
    stackBalance(mod);
    const body = victimBlockBody(mod, 1); // victim is function 1 (after the stub)
    expect(body.map((i) => i.op)).toEqual(["ref.null.extern", "call"]);
    // Defined-function index: 0 imports + position 0.
    expect((body[1] as { funcIdx?: number }).funcIdx).toBe(0);
    const bin = emitBinary(mod);
    expect(WebAssembly.validate(bin)).toBe(true);
    // End-to-end: the branch value flows through the unbox stub (42), not a
    // substituted constant 0.
    const { instance } = await WebAssembly.instantiate(bin, {});
    expect((instance.exports as { victim(): number }).victim()).toBe(42);
  });

  it("without any unbox helper, externref→f64 has no plan row and records branch-type-unfixable", () => {
    const mod = externToF64Module("absent");
    stackBalance(mod);
    const events = getFixupEvents();
    const unfixable = events.find((e) => e.kind === "branch-type-unfixable");
    expect(unfixable, JSON.stringify(events)).toBeTruthy();
    expect(unfixable!.lossy).toBe(true);
    expect(unfixable!.func).toBe("victim");
    expect(unfixable!.detail).toMatch(/externref .*f64/);
  });

  it("funcref→f64 (no bridge) records a lossy branch-type-unfixable event and inserts nothing", () => {
    const mod = funcrefToF64Module();
    stackBalance(mod);
    const body = victimBlockBody(mod);
    expect(body.map((i) => i.op)).toEqual(["ref.func"]); // untouched
    const unfixable = getFixupEvents().find((e) => e.kind === "branch-type-unfixable");
    expect(unfixable).toBeTruthy();
    expect(unfixable!.detail).toMatch(/funcref .*incompatible.*f64/);
  });

  it("branch-type-unfixable becomes a hard error under JS2WASM_STRICT_BALANCE=error", () => {
    const mod = funcrefToF64Module();
    stackBalance(mod);
    process.env.JS2WASM_STRICT_BALANCE = "error";
    const diags = strictBalanceDiagnostics(getFixupEvents());
    const err = diags.find((d) => /branch-type-unfixable/.test(d.message));
    expect(err).toBeTruthy();
    expect(err!.severity).toBe("error");
    expect(err!.message.startsWith("Codegen error:")).toBe(true);
    expect(err!.message).toMatch(/LOSSY/);
  });

  it("summarizeFixups counts branch-type-unfixable", () => {
    stackBalance(funcrefToF64Module());
    const summary = summarizeFixups(getFixupEvents());
    expect(summary["branch-type-unfixable"]).toBe(1);
  });
});

describe("#2140 coercionPlan table extensions (the ONE table, not a fourth copy)", () => {
  const helpers = { boxNumberIdx: 7, unboxNumberIdx: 9 };

  it("eqref→f64 takes the same unbox sequence as ref→f64", () => {
    const plan = coercionPlan({ kind: "eqref" }, { kind: "f64" }, helpers);
    expect(plan).toBeTruthy();
    expect(plan!.lossy ?? false).toBe(false);
    expect(plan!.instrs.map((i) => i.op)).toEqual(["extern.convert_any", "call"]);
    expect((plan!.instrs[1] as { funcIdx?: number }).funcIdx).toBe(9);
  });

  it("anyref→i32 takes the unbox + trunc sequence", () => {
    const plan = coercionPlan({ kind: "anyref" }, { kind: "i32" }, helpers);
    expect(plan).toBeTruthy();
    expect(plan!.instrs.map((i) => i.op)).toEqual(["extern.convert_any", "call", "i32.trunc_sat_f64_s"]);
  });

  it("eqref→f64 WITHOUT an unbox helper is the lossy NaN row (flagged)", () => {
    const plan = coercionPlan({ kind: "eqref" }, { kind: "f64" }, { boxNumberIdx: null, unboxNumberIdx: null });
    expect(plan).toBeTruthy();
    expect(plan!.lossy).toBe(true);
  });

  it("funcref→externref stays the flagged-lossy row (propagated to the event by fixBranchType)", () => {
    const plan = coercionPlan({ kind: "funcref" }, { kind: "externref" }, helpers);
    expect(plan).toBeTruthy();
    expect(plan!.lossy).toBe(true);
  });
});

describe("#2140 fixBranchType — eqref branch results take the widened plan rows", () => {
  it("eqref result in an f64-typed block is unboxed via the shared plan row (not left invalid)", () => {
    const mod = emptyModule();
    // type 0: () -> f64 (victim); type 1: (externref) -> f64 (unbox import)
    mod.types.push({ kind: "func", name: "$f", params: [], results: [{ kind: "f64" }] } as never);
    mod.types.push({
      kind: "func",
      name: "$unbox",
      params: [{ kind: "externref" }],
      results: [{ kind: "f64" }],
    } as never);
    mod.imports.push({ module: "env", name: "__unbox_number", desc: { kind: "func", typeIdx: 1 } } as never);
    mod.functions.push({
      name: "victim",
      typeIdx: 0,
      locals: [],
      body: [
        {
          op: "block",
          blockType: { kind: "val", type: { kind: "f64" } },
          // `ref.null.eq` is an eqref producer inferLastType can see
          // (`local.get` is uninferable — no locals context in the pass).
          body: [{ op: "ref.null.eq" }] as Instr[],
        },
      ] as Instr[],
      exported: false,
    } as never);
    stackBalance(mod);
    const body = victimBlockBody(mod);
    // eqref → f64: extern.convert_any ; call $__unbox_number (widened #2140 row)
    expect(body.map((i) => i.op)).toEqual(["ref.null.eq", "extern.convert_any", "call"]);
    const ev = getFixupEvents().find((e) => e.kind === "branch-type-coerce");
    expect(ev).toBeTruthy();
    expect(ev!.lossy).toBe(false);
    expect(WebAssembly.validate(emitBinary(mod))).toBe(true);
  });
});
