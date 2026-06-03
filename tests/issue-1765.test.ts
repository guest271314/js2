import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndGetExports(source: string): Promise<Record<string, Function>> {
  const result = await compile(source, { fileName: "issue-1765.ts" });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  await expect(WebAssembly.compile(result.binary)).resolves.toBeInstanceOf(WebAssembly.Module);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return instance.exports as Record<string, Function>;
}

describe("#1765 nullable number guard for typed-array byte writes", () => {
  it("writes after a direct append !== null guard and preserves the no-append byte", async () => {
    const exports = await compileAndGetExports(`
      export function writeDirect(flag: boolean): number {
        const output = new Uint8Array(2);
        output[0] = 7;
        let cursor = 0;
        let append: number | null = null;
        if (flag) append = 93;
        if (append !== null) {
          output[cursor] = append;
        }
        return output[0];
      }
    `);

    expect(exports.writeDirect(false)).toBe(7);
    expect(exports.writeDirect(true)).toBe(93);
  });

  it("writes after an aliased append !== null guard and preserves the no-append byte", async () => {
    const exports = await compileAndGetExports(`
      export function writeAliased(flag: boolean): number {
        const output = new Uint8Array(2);
        output[0] = 7;
        let cursor = 0;
        let append: number | null = null;
        if (flag) append = 93;
        const hasAppend = append !== null;
        if (hasAppend) {
          output[cursor] = append;
        }
        return output[0];
      }
    `);

    expect(exports.writeAliased(false)).toBe(7);
    expect(exports.writeAliased(true)).toBe(93);
  });
});
