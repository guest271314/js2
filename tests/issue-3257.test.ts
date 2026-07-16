// #3257 — Tier-2 driver widening: the stdlib-selfhost lowering resolver
// materializes `__vec_elem_set_<vecTypeIdx>` on demand (mirroring
// integration.ts's resolveFunc arm), so self-hosted array-family builtins can
// declare the element-store helper as a typed callee. This pins the arm
// end-to-end: a minimal def whose source calls the helper builds, lowers, and
// registers both functions in a real CodegenContext.
//
// Dialect note pinned here on purpose: the helper's REAL ABI takes an i32
// index, and from-ast validates call args by exact IrType — the probe source
// produces its i32 via a comparison result (`i > 0`), the one i32-producing
// expression the TS dialect has today. f64-index arithmetic callers need an
// `__arri_*`-style f64-ABI wrapper (see the #3257 issue findings).
import { describe, it, expect } from "vitest";
import ts from "typescript";
// Initialize the module graph through the canonical compiler entry FIRST:
// entering it via `src/codegen/index.js` directly trips a pre-existing
// module-init TDZ in the coercion-engine emitter registration chain
// ("Cannot access 'boolToStringEmitter' before initialization" — reproduces
// on main with tests/create-codegen-context.test.ts run standalone).
import "../src/index.js";
import { createCodegenContext } from "../src/codegen/index.js";
import { createEmptyModule } from "../src/ir/types.js";
import { getOrRegisterVecType } from "../src/codegen/registry/types.js";
import { emitSelfHostedFunc, type SelfHostedFuncDef } from "../src/codegen/stdlib-selfhost.js";
import { irVal, type IrType } from "../src/ir/nodes.js";

function makeDummyChecker(): ts.TypeChecker {
  return {} as unknown as ts.TypeChecker;
}

describe("#3257 stdlib-selfhost Tier-2 — __vec_elem_set_<t> on-demand materialization", () => {
  it("builds + lowers a def that calls the element-store helper, materializing it on demand", () => {
    const ctx = createCodegenContext(createEmptyModule(), makeDummyChecker());
    const vecTypeIdx = getOrRegisterVecType(ctx, "f64", { kind: "f64" });
    const helperName = `__vec_elem_set_${vecTypeIdx}`;

    const VEC: IrType = irVal({ kind: "ref_null", typeIdx: vecTypeIdx });
    const F64: IrType = irVal({ kind: "f64" });
    const I32: IrType = irVal({ kind: "i32" });

    const def: SelfHostedFuncDef = {
      name: "__t3257_probe",
      source: `
export function __t3257_probe(v: unknown, i: number, x: number): void {
  ${helperName}(v, i > 0, x);
  return;
}
`,
      paramTypes: [VEC, F64, F64],
      returnType: null,
      calleeTypes: new Map([[helperName, { params: [VEC, I32, F64], returnType: null }]]),
    };

    expect(ctx.funcMap.has(helperName)).toBe(false);
    const probeIdx = emitSelfHostedFunc(ctx, def);

    // Both the probe and the on-demand helper are registered defined functions.
    expect(ctx.funcMap.get("__t3257_probe")).toBe(probeIdx);
    const helperIdx = ctx.funcMap.get(helperName);
    expect(helperIdx).toBeDefined();

    // The lowered probe body carries a baked call to the helper's funcIdx.
    const probeFunc = ctx.mod.functions.find((f) => f.name === "__t3257_probe");
    expect(probeFunc).toBeDefined();
    const calls: number[] = [];
    const walk = (instrs: readonly unknown[]): void => {
      for (const raw of instrs) {
        const i = raw as { op?: string; funcIdx?: number; body?: unknown[]; then?: unknown[]; else?: unknown[] };
        if (i.op === "call" && typeof i.funcIdx === "number") calls.push(i.funcIdx);
        if (Array.isArray(i.body)) walk(i.body);
        if (Array.isArray(i.then)) walk(i.then);
        if (Array.isArray(i.else)) walk(i.else);
      }
    };
    walk(probeFunc!.body);
    expect(calls).toContain(helperIdx);
  });

  it("rejects a non-vec typeIdx loudly (scope guard, not a miscompile)", () => {
    const ctx = createCodegenContext(createEmptyModule(), makeDummyChecker());
    const def: SelfHostedFuncDef = {
      name: "__t3257_bad",
      source: `
export function __t3257_bad(x: number): void {
  __vec_elem_set_9999(x > 0, x > 0, x);
  return;
}
`,
      paramTypes: [irVal({ kind: "f64" })],
      returnType: null,
      calleeTypes: new Map([
        [
          "__vec_elem_set_9999",
          { params: [irVal({ kind: "i32" }), irVal({ kind: "i32" }), irVal({ kind: "f64" })], returnType: null },
        ],
      ]),
    };
    expect(() => emitSelfHostedFunc(ctx, def)).toThrow(/cannot materialize __vec_elem_set_9999/);
  });
});
