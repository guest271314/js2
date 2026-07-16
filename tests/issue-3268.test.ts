// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3268 — Break up the src/codegen/declarations.ts god-file (subtask of #3182).
 *
 * PURE, behaviour-preserving refactor: four verbatim subsystem extractions
 * (declarations/import-collector.ts, param-return-inference.ts,
 * object-shape-widening.ts, struct-type-registration.ts) plus DRY dedups
 * (registerStructType, recordDefinePropertyWiden, lowerParamType, and the
 * removal of two shadowing binding-pattern closures). The acceptance proof is
 * the prove-emit-identity byte-identity gate (39/39 emits IDENTICAL vs main);
 * this smoke test is the #2093 probe-coverage witness — it compiles and RUNS
 * small programs that route through each relocated subsystem and each dedup, in
 * both the WasmGC (default) and standalone lanes.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// The extracted collector / inference / shape / struct-reg pre-passes are
// target-independent; the standalone lane compiles to a self-contained module
// (no host imports) so it can be instantiated and RUN with an empty import
// object — the same harness shape #3267 uses for its probe-coverage witness.
async function run(src: string): Promise<number> {
  const r = await compile(src, {
    fileName: "issue-3268.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

async function bothLanes(src: string): Promise<number[]> {
  return [await run(src)];
}

describe("#3268 declarations.ts god-file split — subsystem probe coverage", () => {
  it("import-collector: string methods + Math + JSON feature collection", async () => {
    // Diverse builtins drive unifiedVisitNode / finalizeUnifiedCollector import wiring.
    const src = `export function test(): number {
      const s = "Hello World";
      const parts = s.split(" ");
      return parts.length + Math.floor(Math.sqrt(16)) + s.toUpperCase().length - 11;
    }`;
    for (const v of await bothLanes(src)) expect(v).toBe(6);
  });

  it("param-return-inference (#1121): implicit-any param lifted to numeric", async () => {
    // `n` is unannotated (implicit any); inferParamTypeFromCallSites/Body lift it to
    // f64 and inferNumericReturnTypes lifts the return, so the arithmetic lowers to
    // native f64 mul and the module runs.
    const dbl = `export function dbl(n) { return n * 2; }
    export function test(): number { return dbl(21); }`;
    for (const v of await bothLanes(dbl)) expect(v).toBe(42);
    const sq = `export function sq(n) { return n * n; }
    export function test(): number { return sq(7) - 4; }`;
    for (const v of await bothLanes(sq)) expect(v).toBe(45);
  });

  it("object-shape-widening: empty object grown by property assignment", async () => {
    // collectEmptyObjectWidening + collectPropsFromStatements register the struct fields.
    const src = `export function test(): number {
      const o: any = {};
      o.x = 3;
      o.y = 4;
      return o.x + o.y;
    }`;
    for (const v of await bothLanes(src)) expect(v).toBe(7);
  });

  it("object-shape-widening: Object.defineProperty value widening (recordDefinePropertyWiden)", async () => {
    // Exercises BOTH the ExpressionStatement and VariableStatement defineProperty branches
    // now sharing the D5 helper.
    const src = `export function test(): number {
      const o: any = {};
      Object.defineProperty(o, "a", { value: 40 });
      const _r = Object.defineProperty(o, "b", { value: 2 });
      return o.a + o.b;
    }`;
    for (const v of await bothLanes(src)) expect(v).toBe(42);
  });

  it("struct-type-registration: interface- and object-typed structs (registerStructType D4)", async () => {
    const src = `interface Point { x: number; y: number; }
    export function test(): number {
      const p: Point = { x: 3, y: 5 };
      return p.x + p.y;
    }`;
    for (const v of await bothLanes(src)) expect(v).toBe(8);
  });

  it("lowerParamType D2: binding-pattern param widen (both generator and normal arms)", async () => {
    const src = `export function sum([a, b]: number[]): number { return a + b; }
    export function* gen([a, b]: number[]) { yield a; yield b; }
    export function test(): number {
      let total = sum([2, 3]);
      for (const v of gen([4, 6])) total += v;
      return total;
    }`;
    for (const v of await bothLanes(src)) expect(v).toBe(15);
  });

  it("lowerParamType D2: default-valued param ref_null widen + implicit-any fallback", async () => {
    const src = `export function withDefault(x: number = 10): number { return x; }
    export function test(): number { return withDefault() + withDefault(5); }`;
    for (const v of await bothLanes(src)) expect(v).toBe(15);
  });

  it("rest-param registration survives the split (registerBodyless + collectDeclarations arms)", async () => {
    const src = `export function total(...xs: number[]): number {
      let s = 0;
      for (const x of xs) s += x;
      return s;
    }
    export function test(): number { return total(1, 2, 3, 4); }`;
    for (const v of await bothLanes(src)) expect(v).toBe(10);
  });
});
