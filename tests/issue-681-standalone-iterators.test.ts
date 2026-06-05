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

  it("drives Array.prototype.keys() for-of natively in standalone (no host import)", async () => {
    // `.keys()` (§23.1.3.16) yields the indices 0..length-1 in order.
    const result = await compile(
      `
        export function f(): number {
          let sum: number = 0;
          for (const index of [10, 20, 30].keys()) {
            sum = sum + index;
          }
          return sum;
        }
      `,
      { target: "standalone" },
    );

    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectNoIteratorHostImports(result);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { f: () => number }).f()).toBe(0 + 1 + 2);
  });

  it("drives Array.prototype.entries() destructured for-of natively in standalone (no host import)", async () => {
    // `.entries()` (§23.1.3.4) yields `[index, value]` for each element.
    const result = await compile(
      `
        export function f(): number {
          let sum: number = 0;
          for (const [index, value] of [10, 20, 30].entries()) {
            sum = sum + index + value;
          }
          return sum;
        }
      `,
      { target: "standalone" },
    );

    expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
    expectNoIteratorHostImports(result);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports as { f: () => number }).f()).toBe(0 + 10 + (1 + 20) + (2 + 30));
  });

  it("keeps keys()/entries() for-of WASI-clean and honors break/continue", async () => {
    const keys = await compile(
      `
        export function f(): number {
          let sum: number = 0;
          for (const i of [9, 9, 9, 9].keys()) {
            if (i === 2) break;
            sum = sum + i;
          }
          return sum;
        }
      `,
      { target: "wasi" },
    );
    expect(keys.success, keys.errors.map((e) => e.message).join("\n")).toBe(true);
    expectNoIteratorHostImports(keys);
    const keysInst = (await WebAssembly.instantiate(keys.binary, {})).instance;
    expect((keysInst.exports as { f: () => number }).f()).toBe(0 + 1);

    const entries = await compile(
      `
        export function f(): number {
          let sum: number = 0;
          for (const [i, v] of [5, 6, 7].entries()) {
            if (i === 1) continue;
            sum = sum + v;
          }
          return sum;
        }
      `,
      { target: "wasi" },
    );
    expect(entries.success, entries.errors.map((e) => e.message).join("\n")).toBe(true);
    expectNoIteratorHostImports(entries);
    const entriesInst = (await WebAssembly.instantiate(entries.binary, {})).instance;
    expect((entriesInst.exports as { f: () => number }).f()).toBe(5 + 7);
  });
});
