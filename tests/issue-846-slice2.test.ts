import { describe, it, expect } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

// #846 slice 2 — array-pattern GetIterator on non-iterable values must throw a
// REAL TypeError instance (not an opaque string-payload exception), so the
// test262 `assert.throws(TypeError, …)` checks — which test `e instanceof
// TypeError` INSIDE the compiled program — observe the correct error type.
//
// Two paths fixed:
//   (1) array assignment destructuring `[a] = 5`  (src/codegen/expressions/assignment.ts)
//   (2) for-of array binding pattern `for (let [x] of [1])` (src/codegen/statements/loops.ts)
//
// Spec: §13.15.5.2 ArrayAssignmentPattern → GetIterator; §8.5.2/§8.5.3
// IteratorBindingInitialization → GetIterator. A primitive number/boolean lacks
// [Symbol.iterator] so GetIterator throws TypeError. Strings ARE iterable and
// must NOT throw.

async function runReturn(code: string): Promise<unknown> {
  const result = await compile(code, { fileName: "test.ts" });
  if (!result.success) throw new Error(`CE: ${result.errors[0]?.message}`);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  return (instance.exports as any).test();
}

describe("#846 slice 2 — non-iterable array destructuring throws real TypeError", () => {
  it("array assignment of a number throws a TypeError instance", async () => {
    // returns 1 only if the caught value passes `instanceof TypeError`
    const r = await runReturn(`let g: any;
export function test(): number {
  try { ([g] = (5 as any)); return 0; } catch (e) { if (e instanceof TypeError) return 1; return 2; }
}`);
    expect(r).toBe(1);
  });

  it("array assignment of null throws a TypeError instance", async () => {
    const r = await runReturn(`let g: any;
export function test(): number {
  try { ([g] = (null as any)); return 0; } catch (e) { if (e instanceof TypeError) return 1; return 2; }
}`);
    expect(r).toBe(1);
  });

  it("array assignment of undefined throws a TypeError instance", async () => {
    const r = await runReturn(`let g: any;
export function test(): number {
  try { ([g] = (undefined as any)); return 0; } catch (e) { if (e instanceof TypeError) return 1; return 2; }
}`);
    expect(r).toBe(1);
  });

  it("array assignment of a string does NOT throw (strings are iterable)", async () => {
    const r = await runReturn(`let g: any;
export function test(): number {
  try { ([g] = ("ab" as any)); return (g === "a") ? 1 : 0; } catch (e) { return 2; }
}`);
    expect(r).toBe(1);
  });

  it("array assignment of an array does NOT throw", async () => {
    const r = await runReturn(`let g: any;
export function test(): number {
  try { ([g] = ([7] as any)); return (g === 7) ? 1 : 0; } catch (e) { return 2; }
}`);
    expect(r).toBe(1);
  });

  it("for-of array pattern over numbers throws a TypeError instance", async () => {
    const r = await runReturn(`let acc = 0;
export function test(): number {
  try { for (let [x] of ([1] as any[])) { acc++; } return 0; } catch (e) { if (e instanceof TypeError) return 1; return 2; }
}`);
    expect(r).toBe(1);
  });

  it("for-of EMPTY array pattern over numbers still throws (GetIterator runs first)", async () => {
    const r = await runReturn(`let acc = 0;
export function test(): number {
  try { for (let [] of ([1] as any[])) { acc++; } return 0; } catch (e) { if (e instanceof TypeError) return 1; return 2; }
}`);
    expect(r).toBe(1);
  });

  it("for-of array pattern over tuples does NOT throw (valid iteration)", async () => {
    const r = await runReturn(`let s = 0;
export function test(): number {
  const pairs: [number, number][] = [[1, 2], [3, 4]];
  for (const [a, b] of pairs) { s += a + b; }
  return s;
}`);
    expect(r).toBe(10);
  });

  it("for-of array pattern over arrays does NOT throw (valid iteration)", async () => {
    const r = await runReturn(`let s = 0;
export function test(): number {
  const grid: number[][] = [[1, 2], [3, 4]];
  for (const [a, b] of grid) { s += a * b; }
  return s;
}`);
    expect(r).toBe(14);
  });

  it("for-of OBJECT pattern over numbers does NOT throw (numbers are object-coercible)", async () => {
    const r = await runReturn(`let s = 0;
export function test(): number {
  try { for (const { x } of [1, 2]) { s += 100; } return s; } catch (e) { return -1; }
}`);
    expect(r).toBe(200);
  });

  it("plain for-of binding over numbers does NOT throw", async () => {
    const r = await runReturn(`let s = 0;
export function test(): number {
  for (const x of [1, 2, 3]) { s += x; }
  return s;
}`);
    expect(r).toBe(6);
  });
});
