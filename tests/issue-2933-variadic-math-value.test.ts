// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2933 — Math.max / Math.min as first-class VALUES under `--target standalone`.
 *
 * These are genuinely VARIADIC (§21.3.2.24/.25), so they cannot use the
 * fixed-arity value-closure convention the other wired statics use. They reify
 * with the canonical variadic closure convention instead: ONE
 * `(ref null $vec_externref)` args param (see `ctx.variadicBuiltinClosure`),
 * packed by a dedicated any-callee dispatch arm in
 * `tryEmitInlineDynamicCall` (calls.ts), so a single identity-stable singleton
 * serves EVERY call-site arity.
 *
 * Host mode is untouched (the dynamic-call `const g: any = Math.max; g(...)`
 * host path silently returns 0 on clean main — pre-existing, verified — and
 * every change here is `ctx.standalone || ctx.wasi` gated; byte-identity vs
 * main is proven over the 56-entry emit-identity corpus).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<Record<string, Function>> {
  const result = await compile(source, { fileName: "test.ts", target: "standalone" });
  if (!result.binary || result.binary.length === 0) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return instance.exports as Record<string, Function>;
}

describe("#2933 — variadic Math.max/Math.min value reads (standalone)", () => {
  it("calls an extracted Math.max at every arity", async () => {
    const exports = await runStandalone(`
      export function zero(): number {
        const g: any = Math.max;
        return g() === -Infinity ? 1 : 0;
      }
      export function one(): number {
        const g: any = Math.max;
        return g(-5);
      }
      export function two(): number {
        const g: any = Math.max;
        return g(1, 9);
      }
      export function acceptance(): number {
        const g: any = Math.max;
        return g(1, 2, 3) === 3 ? 1 : 0;
      }
      export function five(): number {
        const g: any = Math.max;
        return g(3, 1, 4, 1, 5);
      }
    `);
    expect(exports.zero!()).toBe(1); // Math.max() = -Infinity
    expect(exports.one!()).toBe(-5);
    expect(exports.two!()).toBe(9);
    expect(exports.acceptance!()).toBe(1); // the #2933 acceptance criterion
    expect(exports.five!()).toBe(5);
  });

  it("calls an extracted Math.min at every arity", async () => {
    const exports = await runStandalone(`
      export function zero(): number {
        const m: any = Math.min;
        return m() === Infinity ? 1 : 0;
      }
      export function three(): number {
        const m: any = Math.min;
        return m(4, 2, 7);
      }
    `);
    expect(exports.zero!()).toBe(1); // Math.min() = +Infinity
    expect(exports.three!()).toBe(2);
  });

  it("propagates NaN per §21.3.2.24 step 2 (any-NaN → NaN)", async () => {
    const exports = await runStandalone(`
      export function nanArg(): number {
        const g: any = Math.max;
        const r: any = g(1, NaN, 3);
        return r !== r ? 1 : 0;
      }
      export function undefArg(): number {
        const g: any = Math.max;
        const r: any = g(1, undefined);
        return r !== r ? 1 : 0; // ToNumber(undefined) = NaN
      }
    `);
    expect(exports.nanArg!()).toBe(1);
    expect(exports.undefArg!()).toBe(1);
  });

  it("orders signed zeros per spec (max(+0,-0)=+0, min(+0,-0)=-0)", async () => {
    const exports = await runStandalone(`
      export function signedZero(): number {
        const g: any = Math.max;
        const m: any = Math.min;
        const mx: number = g(0, -0);
        const mn: number = m(0, -0);
        return (1 / mx === Infinity && 1 / mn === -Infinity) ? 1 : 0;
      }
    `);
    expect(exports.signedZero!()).toBe(1);
  });

  it("coerces non-number args through ToNumber (booleans)", async () => {
    const exports = await runStandalone(`
      export function boolCoerce(): number {
        const g: any = Math.max;
        return g(true, false); // ToNumber(true)=1, ToNumber(false)=0
      }
    `);
    expect(exports.boolCoerce!()).toBe(1);
  });

  it("keeps value identity singleton-stable and distinct per method", async () => {
    const exports = await runStandalone(`
      export function ident(): number {
        const a: any = Math.max;
        const b: any = Math.max;
        const m: any = Math.min;
        return (a === b && a !== m) ? 1 : 0;
      }
    `);
    expect(exports.ident!()).toBe(1);
  });

  it("does not regress the direct call forms or fixed-arity value reads", async () => {
    const exports = await runStandalone(`
      export function directMax(): number {
        return Math.max(1, 9, 3);
      }
      export function directMin(): number {
        return Math.min(4, 2);
      }
      export function fixedArityValueRead(): number {
        const isArr: any = Array.isArray;
        return isArr([1]) ? 1 : 0;
      }
    `);
    expect(exports.directMax!()).toBe(9);
    expect(exports.directMin!()).toBe(2);
    expect(exports.fixedArityValueRead!()).toBe(1);
  });
});
