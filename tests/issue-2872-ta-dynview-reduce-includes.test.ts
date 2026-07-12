// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2872 (slice: dyn-view reduce/reduceRight + boolean-result boxing) — standalone
 * `%TypedArray%.prototype.{reduce,reduceRight,includes}` on a dynamically-
 * constructed view reached through an `any` receiver (the
 * `testWithTypedArrayConstructors(TA => new TA(…).reduce(…))` harness shape).
 *
 * REUSE, not new machinery: `reduce`/`reduceRight` join the #3058
 * `DYN_VIEW_READ_METHODS` set, so the existing dyn-view two-arm materializes the
 * view to an `$__vec_f64` and re-enters the ORDINARY native array-HOF impl — no
 * per-method TA handler. `includes` was already in that set but returned a
 * NUMBER-boxed 0/1 (so `result === true`/`=== false` failed while truthiness
 * worked); the two-arm now boxes boolean-result methods via `__box_boolean`
 * (the shared {@link BOOLEAN_RESULT_METHODS} fix — also latent for a future
 * `every`/`some`).
 *
 * Every case asserts host-free instantiation (`WebAssembly.instantiate(binary,
 * {})`) and zero env imports — the prior `Uint8ClampedArray_*` / `__make_callback`
 * leak is gone on this path.
 */

async function runStandalone(src: string): Promise<{ value: unknown; envImports: string[] }> {
  const r = await compile(src, { target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : r.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  if (!r.success) throw new Error("unreachable");
  const envImports = r.imports.filter((i) => i.module === "env").map((i) => i.name);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const value = (instance.exports as { test: () => unknown }).test();
  return { value, envImports };
}

// Wrap the body in a per-constructor helper so the receiver is a dynamically
// constructed view held in an `any` param (the harness shape that produces a
// boxed `$__ta_dyn_view`), across a representative kind set.
const withTA = (ctor: string, body: string) =>
  `export function test(): number { function run(TA: any): number { ${body} } return run(${ctor}); }`;

describe("#2872 — dyn-view reduce/reduceRight (standalone, host-free)", { timeout: 30000 }, () => {
  it("reduce with an initial value", async () => {
    const { value, envImports } = await runStandalone(
      withTA(
        "Int16Array",
        `const a: any = new TA([1, 2, 3, 4]); return a.reduce(function (x: any, y: any) { return x + y; }, 0) === 10 ? 1 : 0;`,
      ),
    );
    expect(value).toBe(1);
    expect(envImports).toEqual([]);
  });

  it("reduce with no initial value seeds from the first element", async () => {
    const { value } = await runStandalone(
      withTA(
        "Float64Array",
        `const a: any = new TA([2, 3, 4]); return a.reduce(function (x: any, y: any) { return x + y; }) === 9 ? 1 : 0;`,
      ),
    );
    expect(value).toBe(1);
  });

  it("reduce callback sees (accumulator, value, index)", async () => {
    const { value } = await runStandalone(
      withTA(
        "Uint32Array",
        `const a: any = new TA([10, 20, 30]); let lastIdx = -1; a.reduce(function (acc: any, v: any, i: any) { lastIdx = i; return acc + v; }, 0); return lastIdx === 2 ? 1 : 0;`,
      ),
    );
    expect(value).toBe(1);
  });

  it("reduceRight folds right-to-left", async () => {
    // Order captured numerically (acc*10+v): 0→3→32→321 proves 3,2,1 visitation.
    const { value, envImports } = await runStandalone(
      withTA(
        "Int8Array",
        `const a: any = new TA([1, 2, 3]); return a.reduceRight(function (acc: any, v: any) { return acc * 10 + v; }, 0) === 321 ? 1 : 0;`,
      ),
    );
    expect(value).toBe(1);
    expect(envImports).toEqual([]);
  });
});

describe("#2872 — dyn-view includes boolean identity (standalone, host-free)", { timeout: 30000 }, () => {
  it("includes(present) === true (was number-boxed 1, failed strict-eq)", async () => {
    const { value, envImports } = await runStandalone(
      withTA("Float32Array", `const a: any = new TA([1, 2, 3]); return a.includes(2) === true ? 1 : 0;`),
    );
    expect(value).toBe(1);
    expect(envImports).toEqual([]);
  });

  it("includes(absent) === false", async () => {
    const { value } = await runStandalone(
      withTA("Int16Array", `const a: any = new TA([1, 2, 3]); return a.includes(9) === false ? 1 : 0;`),
    );
    expect(value).toBe(1);
  });

  it("includes truthiness still holds", async () => {
    const { value } = await runStandalone(
      withTA("Uint8Array", `const a: any = new TA([5, 6, 7]); return a.includes(6) ? 1 : 0;`),
    );
    expect(value).toBe(1);
  });
});

describe("#2872 — GUARDS: plain-array any receiver unaffected", { timeout: 30000 }, () => {
  it("plain array reduce still native + host-free", async () => {
    const { value, envImports } = await runStandalone(
      `export function test(): number { const a: any = [1, 2, 3]; return a.reduce(function (x: any, y: any) { return x + y; }, 0) === 6 ? 1 : 0; }`,
    );
    expect(value).toBe(1);
    expect(envImports).toEqual([]);
  });

  it("plain array includes === true unaffected by the boolean-box change", async () => {
    const { value } = await runStandalone(
      `export function test(): number { const a: any = [1, 2, 3]; return a.includes(2) === true ? 1 : 0; }`,
    );
    expect(value).toBe(1);
  });
});
