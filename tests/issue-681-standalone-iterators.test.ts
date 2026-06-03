// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const ITERATOR_HOST_IMPORT_RE = /__(?:async_)?iterator|__array_(?:entries|keys|values)/;

function importNames(result: Awaited<ReturnType<typeof compile>>): string[] {
  return result.imports.map((i) => `${i.module}::${i.name}`);
}

function expectNoIteratorHostImports(result: Awaited<ReturnType<typeof compile>>) {
  const names = importNames(result);
  expect(names.filter((name) => ITERATOR_HOST_IMPORT_RE.test(name))).toEqual([]);
  expect(result.wat).not.toMatch(ITERATOR_HOST_IMPORT_RE);
}

async function expectIteratorRefused(src: string, target: "standalone" | "wasi" = "standalone") {
  const result = await compile(src, { target });
  expect(result.success, `expected #681 refusal, got success for:\n${src}`).toBe(false);
  expect(result.errors.some((e) => /#681/.test(e.message))).toBe(true);
  expectNoIteratorHostImports(result);
  return result;
}

describe("#681 standalone iterator protocol slice", () => {
  it("keeps direct array for-of standalone-clean", async () => {
    const result = await compile(
      `
        export function f(): number {
          let sum: number = 0;
          for (const value of [1, 2, 3, 4]) {
            sum = sum + value;
          }
          return sum;
        }
      `,
      { target: "standalone" },
    );

    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectNoIteratorHostImports(result);
  });

  it("keeps array for-of destructuring standalone-clean", async () => {
    const result = await compile(
      `
        export function f(): number {
          let sum: number = 0;
          for (const [left, right] of [[1, 2], [3, 4]]) {
            sum = sum + left + right;
          }
          return sum;
        }
      `,
      { target: "standalone" },
    );

    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectNoIteratorHostImports(result);
  });

  it("refuses unknown for-of iterables in standalone instead of importing __iterator", async () => {
    const result = await expectIteratorRefused(`
      export function f(xs: any): number {
        let count: number = 0;
        for (const value of xs) {
          count = count + 1;
        }
        return count;
      }
    `);
    expect(result.errors.some((e) => /generic\/custom iterables/.test(e.message))).toBe(true);
  });

  it("keeps typed-array for-of WASI-clean", async () => {
    const result = await compile(
      `
        export function f(xs: Uint8Array): number {
          let sum: number = 0;
          for (const value of xs) {
            sum = sum + value;
          }
          return sum;
        }
      `,
      { target: "wasi" },
    );

    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectNoIteratorHostImports(result);
  });

  it("drives Array.prototype.values() for-of natively in standalone (no host import)", async () => {
    // `for (x of arr.values())` is semantically identical to `for (x of arr)`,
    // so the array index loop drives it directly — no __array_values import.
    const result = await compile(
      `
        export function f(): number {
          let sum: number = 0;
          for (const value of [1, 2, 3, 4].values()) {
            sum = sum + value;
          }
          return sum;
        }
      `,
      { target: "standalone" },
    );

    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectNoIteratorHostImports(result);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { f: () => number }).f()).toBe(10);
  });

  it("still refuses Array.prototype.keys()/entries() in standalone (out of #681 .values() slice)", async () => {
    const keysResult = await expectIteratorRefused(`
      export function f(): number {
        let sum: number = 0;
        for (const index of [1, 2, 3].keys()) {
          sum = sum + index;
        }
        return sum;
      }
    `);
    expect(keysResult.errors.some((e) => /Array\.prototype\.keys/.test(e.message))).toBe(true);
  });
});
