import { describe, it, expect } from "vitest";
import { compile } from "./src/index.js";
import { buildImports } from "./src/runtime.js";

// #1815 — Array.prototype.splice dropped inserted items (arguments[2..]).
// `[1,2,3].splice(1,1,'a','b')` left `[1,3]` instead of `[1,'a','b',3]`.
// compileArraySplice only read start + deleteCount and never the items, and
// the in-place tail-shift path could not grow the backing array. The fix
// rebuilds the backing array when items are inserted (ECMAScript §23.1.3.30).

async function run(source: string): Promise<number> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => number }).test();
}

// Pack arr + removed into one number: arrLen, each arr elem, remLen, each removed
// elem — all single-digit in these fixtures.
function fixture(setup: string): string {
  return `
    export function test(): number {
      ${setup}
      let acc = arr.length;
      for (let i = 0; i < arr.length; i = i + 1) acc = acc * 10 + arr[i];
      acc = acc * 10 + removed.length;
      for (let i = 0; i < removed.length; i = i + 1) acc = acc * 10 + removed[i];
      return acc;
    }
  `;
}

describe("#1815 — splice inserts items (3+ args)", () => {
  it("replaces 1 element with 2 inserted items", async () => {
    // [1,2,3].splice(1,1,7,8) -> arr [1,7,8,3], removed [2] -> 4 1 7 8 3 1 2
    const src = fixture(`const arr = [1, 2, 3]; const removed = arr.splice(1, 1, 7, 8);`);
    expect(await run(src)).toBe(4178312);
  });

  it("deletes more than it inserts (shrinks)", async () => {
    // [1,2,3,4,5].splice(2,2,9) -> arr [1,2,9,5], removed [3,4] -> 4 1 2 9 5 2 3 4
    const src = fixture(`const arr = [1, 2, 3, 4, 5]; const removed = arr.splice(2, 2, 9);`);
    expect(await run(src)).toBe(41295234);
  });

  it("pure insertion (deleteCount 0) grows the array", async () => {
    // [1,2,3].splice(1,0,8,9) -> arr [1,8,9,2,3], removed [] -> 5 1 8 9 2 3 0
    const src = fixture(`const arr = [1, 2, 3]; const removed = arr.splice(1, 0, 8, 9);`);
    expect(await run(src)).toBe(5189230);
  });

  it("appends when start === length", async () => {
    // [1,2,3].splice(3,0,4,5) -> arr [1,2,3,4,5], removed [] -> 5 1 2 3 4 5 0
    const src = fixture(`const arr = [1, 2, 3]; const removed = arr.splice(3, 0, 4, 5);`);
    expect(await run(src)).toBe(5123450);
  });

  it("still works for delete-only splice (no items)", async () => {
    // [1,2,3,4].splice(1,2) -> arr [1,4], removed [2,3] -> 2 1 4 2 2 3
    const src = fixture(`const arr = [1, 2, 3, 4]; const removed = arr.splice(1, 2);`);
    expect(await run(src)).toBe(214223);
  });
});
