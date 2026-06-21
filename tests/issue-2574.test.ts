import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";

// #2574 — array-destructuring default not applied on an explicit `undefined`
// element. `const [a=9] = [undefined]` should be 9 (§8.5.3: the default fires
// when the bound value is `undefined`), but read NaN standalone. Root cause: the
// single-element literal stores the f64 sNaN "undefined" sentinel in a `__vec`/
// tuple f64 field, but the array-destructuring read coerced that f64 → externref
// via `__box_number` (a NaN NUMBER) BEFORE the default check, which then used
// `__extern_is_undefined` (not the f64-sentinel arm) and saw a number → default
// never fired. Fix: run the f64-sentinel default check on the RAW f64 field
// first, then coerce the resolved f64 to the binding's wider type.

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#2574 array-destructuring default on undefined element", () => {
  it("[a=9] = [undefined] applies the default (§8.5.3)", async () => {
    expect(
      await runStandalone(`export function test(): number { const [a = 9] = [undefined as any]; return a; }`),
    ).toBe(9);
  });

  it("[a=9] = [5] keeps the present value (no regression)", async () => {
    expect(await runStandalone(`export function test(): number { const [a = 9] = [5]; return a; }`)).toBe(5);
  });

  it("[a=9] = [] applies the default on a done iterator (no regression)", async () => {
    expect(await runStandalone(`export function test(): number { const [a = 9] = ([] as number[]); return a; }`)).toBe(
      9,
    );
  });

  it("[a=9,b=8] = [1, undefined] applies the second default (no regression)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const [a = 9, b = 8] = [1, undefined as any]; return a*10 + b; }`,
      ),
    ).toBe(18);
  });

  it("let [a=9] = [undefined] applies the default", async () => {
    expect(await runStandalone(`export function test(): number { let [a = 9] = [undefined as any]; return a; }`)).toBe(
      9,
    );
  });

  it("[a=9, b=8] = [undefined, 2] applies the first default", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const [a = 9, b = 8] = [undefined as any, 2]; return a*10 + b; }`,
      ),
    ).toBe(92);
  });

  it("function param [a=9] over [undefined] applies the default (no regression)", async () => {
    expect(
      await runStandalone(
        `function f([a = 9]: number[]): number { return a; } export function test(): number { return f([undefined as any]); }`,
      ),
    ).toBe(9);
  });
});
