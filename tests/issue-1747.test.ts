import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function instantiate(src: string): Promise<WebAssembly.Exports> {
  const r = await compile(src);
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors.map((e) => e.message).join(", ")}\n${r.wat}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const m = await WebAssembly.instantiate(r.binary, imports);
  const setExports = (imports as { setExports?: (exports: WebAssembly.Exports) => void }).setExports;
  if (typeof setExports === "function") setExports(m.instance.exports);
  return m.instance.exports;
}

describe("#1747 - Array.prototype.pop on empty arrays", () => {
  it("number[].pop() on an empty array returns undefined", async () => {
    const ex = await instantiate(`
      export function run(): number {
        const a: number[] = [];
        const x = a.pop();
        if (x === undefined) return 1;
        return -1;
      }
    `);
    expect((ex.run as () => number)()).toBe(1);
  });

  it("number[].shift() on an empty array returns undefined", async () => {
    const ex = await instantiate(`
      export function run(): number {
        const a: number[] = [];
        const x = a.shift();
        if (x === undefined) return 1;
        return -1;
      }
    `);
    expect((ex.run as () => number)()).toBe(1);
  });

  it("number[].pop() still returns the last number for non-empty arrays", async () => {
    const ex = await instantiate(`
      export function run(): number {
        const a: number[] = [10, 20, 30];
        const x = a.pop();
        if (x === undefined) return -1;
        return x;
      }
    `);
    expect((ex.run as () => number)()).toBe(30);
  });
});
