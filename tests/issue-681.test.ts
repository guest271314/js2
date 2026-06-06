// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const ITER_HOST_IMPORT_RE = /__(?:async_)?iterator|__array_(?:entries|keys|values)/;

function expectNoIteratorHostImports(result: Awaited<ReturnType<typeof compile>>) {
  const names = result.imports.map((i) => `${i.module}::${i.name}`);
  expect(names.filter((name) => ITER_HOST_IMPORT_RE.test(name))).toEqual([]);
}

async function runF(src: string, target: "standalone" | "wasi" = "standalone"): Promise<number> {
  const result = await compile(src, { target });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expectNoIteratorHostImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { f: () => number }).f();
}

describe("#681 pure-Wasm array iterator for-of", () => {
  it("continues Array.prototype.values() without repeating the skipped element", async () => {
    expect(
      await runF(`
        export function f(): number {
          let sum: number = 0;
          for (const value of [1, 2, 3, 4].values()) {
            if (value === 2) continue;
            sum = sum + value;
          }
          return sum;
        }
      `),
    ).toBe(1 + 3 + 4);
  });

  it("continues Array.prototype.keys() without repeating the skipped index", async () => {
    expect(
      await runF(`
        export function f(): number {
          let sum: number = 0;
          for (const index of [9, 9, 9, 9].keys()) {
            if (index === 1) continue;
            sum = sum + index;
          }
          return sum;
        }
      `),
    ).toBe(0 + 2 + 3);
  });

  it("continues Array.prototype.entries() under WASI without repeating the skipped pair", async () => {
    expect(
      await runF(
        `
          export function f(): number {
            let sum: number = 0;
            for (const [index, value] of [5, 6, 7].entries()) {
              if (index === 1) continue;
              sum = sum + value;
            }
            return sum;
          }
        `,
        "wasi",
      ),
    ).toBe(5 + 7);
  });
});
