import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #1639 — `genFn.prototype` member access must resolve the intrinsic generator
// prototype chain so the test262 GeneratorPrototype / AsyncIteratorPrototype
// reflection suites navigate
//   instance → genFn.prototype → %(Async)GeneratorPrototype% → %(Async)IteratorPrototype%.
async function run(body: string): Promise<unknown> {
  const result = compile(`${body}`);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  if (typeof (imports as any).setExports === "function") (imports as any).setExports(instance.exports);
  return (instance.exports as any).test();
}

describe("#1639 generator/async-generator prototype chain", () => {
  it("async generator: %AsyncIteratorPrototype%[@@asyncIterator] exists and returns this", async () => {
    const src = `
      async function* generator() {}
      export function test(): number {
        const p1 = Object.getPrototypeOf(generator.prototype);
        const p2 = Object.getPrototypeOf(p1);
        const fn = (p2 !== null && p2 !== undefined) ? p2[Symbol.asyncIterator] : undefined;
        let out = 0;
        if (typeof fn === 'function') { out = out + 1; }
        if (typeof fn === 'function' && fn.call(42) === 42) { out = out + 2; }
        return out;
      }`;
    expect(await run(src)).toBe(3);
  });

  it("async generator: @@asyncIterator function name is '[Symbol.asyncIterator]' and length 0", async () => {
    const src = `
      async function* generator() {}
      export function test(): number {
        const aip = Object.getPrototypeOf(Object.getPrototypeOf(generator.prototype));
        const fn = aip[Symbol.asyncIterator];
        let out = 0;
        if (fn.name === '[Symbol.asyncIterator]') { out = out + 1; }
        if (fn.length === 0) { out = out + 2; }
        return out;
      }`;
    expect(await run(src)).toBe(3);
  });

  it("sync generator: prototype chain reaches a non-Object.prototype %IteratorPrototype%", async () => {
    const src = `
      function* generator() {}
      export function test(): number {
        const p1 = Object.getPrototypeOf(generator.prototype);
        const p2 = Object.getPrototypeOf(p1);
        return (p2 !== null && p2 !== undefined && p2 !== Object.prototype) ? 1 : 0;
      }`;
    expect(await run(src)).toBe(1);
  });

  it("generator instance [[Prototype]] === genFn.prototype (spec identity)", async () => {
    const src = `
      function* g() { yield 1; }
      export function test(): number {
        const it = g();
        return (Object.getPrototypeOf(it) === g.prototype) ? 1 : 0;
      }`;
    expect(await run(src)).toBe(1);
  });

  it("Generator.prototype.next.call(non-generator) throws TypeError (brand check, no trap)", async () => {
    const src = `
      function* g() { yield 1; }
      export function test(): number {
        const next = g.prototype.next;
        let threw = 0;
        try { next.call({}); } catch (e) { if (e instanceof TypeError) { threw = 1; } }
        return threw;
      }`;
    expect(await run(src)).toBe(1);
  });

  it("generator still iterates after instance-prototype rewiring", async () => {
    const src = `
      function* g() { yield 1; yield 2; yield 3; }
      export function test(): number {
        let sum = 0;
        for (const x of g()) { sum += x; }
        return sum;
      }`;
    expect(await run(src)).toBe(6);
  });
});
