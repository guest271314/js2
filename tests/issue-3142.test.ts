// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3142 Slice 1 — module-level (top-level statement) claim assessment.
//
// The selector now reports an `IrModuleInitAssessment` on `IrSelection`
// (`moduleInit`) when `trackFallbacks` is on: the top-level statement
// population is shape-checked with the SAME per-kind rules as a claimed
// function body (constructor-body precedent — void unit, no tail
// requirement, early-return barrier armed), then gated through the same
// external-call / call-graph-closure logic as Step 2.
//
// Slice 1 is selector-only (mirrors #1370 Phase A): nothing consumes the
// assessment in codegen yet — these tests pin the selector verdicts and the
// telemetry contract so Slice 2 (lowering + `__module_init` patch) can flip
// it to claim-feeding without re-litigating the population definition.

import { describe, expect, it } from "vitest";
import ts from "typescript";
import { planIrCompilation } from "../src/ir/select.js";

function plan(source: string, trackFallbacks = true) {
  const sf = ts.createSourceFile("test.ts", source, ts.ScriptTarget.ES2022, /* setParentNodes */ true);
  return planIrCompilation(sf, { experimentalIR: true, trackFallbacks });
}

describe("#3142 Slice 1 — module-init claim assessment", () => {
  it("declarations-only module: vacuously claimable with stmtCount 0", () => {
    const sel = plan(`
      function add(a: number, b: number): number { return a + b; }
      function mul(a: number, b: number): number { return a * b; }
    `);
    expect(sel.moduleInit).toBeDefined();
    expect(sel.moduleInit!.stmtCount).toBe(0);
    expect(sel.moduleInit!.reason).toBeNull();
  });

  it("claimable init: var decl + assignment + call to a claimed function", () => {
    const sel = plan(`
      function add(a: number, b: number): number { return a + b; }
      let total: number = 0;
      total = add(1, 2);
    `);
    expect(sel.funcs.has("add")).toBe(true);
    expect(sel.moduleInit).toBeDefined();
    expect(sel.moduleInit!.stmtCount).toBe(2);
    expect(sel.moduleInit!.reason).toBeNull();
  });

  it("body-shape rejection: a top-level statement kind the IR does not own", () => {
    // `switch` has no isPhase1BodyStatement arm — the unit must reject with
    // the same reason bucket a function body would.
    const sel = plan(`
      function add(a: number, b: number): number { return a + b; }
      switch (1) { default: break; }
    `);
    expect(sel.moduleInit).toBeDefined();
    expect(sel.moduleInit!.reason).toBe("body-shape-rejected");
  });

  it("top-level return rejects (early-return barrier armed)", () => {
    // A bare top-level `return` is not claimable; the barrier must reject it
    // rather than treating the void unit like a loop-body early exit.
    const sel = plan(`
      function f(a: number): number { return a; }
      return;
    `);
    expect(sel.moduleInit).toBeDefined();
    expect(sel.moduleInit!.reason).toBe("body-shape-rejected");
  });

  it("external-call rejection: top-level call to a non-local identifier", () => {
    const sel = plan(`
      function f(a: number): number { return a; }
      parseInt("42");
    `);
    expect(sel.moduleInit).toBeDefined();
    expect(sel.moduleInit!.reason).toBe("external-call");
  });

  it("call-graph-closure rejection: top-level call to an unclaimed local function", () => {
    // `g` has unannotated params and no TypeMap is provided, so it is not
    // individually claimable — the module-init unit calling it must reject
    // with call-graph-closure, exactly like a claimed function would.
    const sel = plan(`
      function g(a): number { return 1; }
      g(1);
    `);
    expect(sel.funcs.has("g")).toBe(false);
    expect(sel.moduleInit).toBeDefined();
    expect(sel.moduleInit!.reason).toBe("call-graph-closure");
  });

  it("not populated without trackFallbacks (production compiles untouched)", () => {
    const sel = plan(
      `
      function add(a: number, b: number): number { return a + b; }
      let total: number = 0;
      total = add(1, 2);
    `,
      /* trackFallbacks */ false,
    );
    expect(sel.moduleInit).toBeUndefined();
  });

  it("import/export/type declarations are not module-init work", () => {
    const sel = plan(`
      export function add(a: number, b: number): number { return a + b; }
      interface P { x: number }
      type Q = number;
      export default add;
    `);
    expect(sel.moduleInit).toBeDefined();
    expect(sel.moduleInit!.stmtCount).toBe(0);
    expect(sel.moduleInit!.reason).toBeNull();
  });
});
