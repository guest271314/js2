// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-1891.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  await expect(WebAssembly.compile(result.binary)).resolves.toBeDefined();
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as Record<string, () => number>).run();
}

describe("#1891 — standalone generator-method destructuring params keep call indices stable", () => {
  it("array rest parameter validates and executes", async () => {
    const value = await runStandalone(`
      let seen = 0;
      class C {
        *gen([a, ...rest]: any) {
          seen = a + rest[0];
          yield seen;
        }
      }
      export function run(): number {
        new C().gen([2, 5]).next();
        return seen;
      }
    `);
    expect(value).toBe(7);
  });

  it("array parameter without rest validates and executes", async () => {
    const value = await runStandalone(`
      let seen = 0;
      class C {
        *gen([a, b]: any) {
          seen = a * 10 + b;
          yield a;
        }
      }
      export function run(): number {
        new C().gen([3, 4]).next();
        return seen;
      }
    `);
    expect(value).toBe(34);
  });
});
