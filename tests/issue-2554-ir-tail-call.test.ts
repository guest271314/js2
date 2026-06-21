// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2554 — IR path drops tail calls on top-level recursive functions.
 *
 * The legacy AST return path rewrites a tail `return f(...)` into `return_call`
 * (#602). The IR `return` lowering never did, so IR-claimed (top-level)
 * recursive functions lost TCO and deep recursion overflowed the Wasm stack —
 * while the SAME function nested inside another (legacy path) kept the tail call.
 *
 * Fix: `applyIrTailCalls` (src/codegen/ir-tail-call.ts), applied in the IR
 * integration layer with the legacy guards (param-count + return-type match,
 * never inside a try-with-handler).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateWithRuntime } from "./equivalence/helpers.js";

async function run(src: string, standalone = false): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", ...(standalone ? { target: "standalone" as const } : {}) });
  expect(r.success, r.success ? "" : r.errors?.[0]?.message).toBe(true);
  const inst = await instantiateWithRuntime(r);
  return (inst.exports as { test(): number }).test();
}

const TOP_LEVEL = `function sum(n: number, acc: number): number { if (n === 0) return acc; return sum(n - 1, acc + n); }
export function test(): number { return sum(1000000, 0); }`;

describe("#2554 IR tail-call optimization for top-level recursion", () => {
  it("top-level 1e6 tail recursion does not overflow (host)", async () => {
    expect(await run(TOP_LEVEL)).toBe(500000500000);
  });

  it("top-level 1e6 tail recursion does not overflow (standalone)", async () => {
    expect(await run(TOP_LEVEL, true)).toBe(500000500000);
  });

  it("top-level 2e6 (deeper) still fine — proves frame reuse, not just a bigger stack", async () => {
    expect(
      await run(`function sum(n: number, acc: number): number { if (n === 0) return acc; return sum(n - 1, acc + n); }
export function test(): number { return sum(2000000, 0); }`),
    ).toBe(2000001000000);
  });

  it("nested recursion (legacy path) still works", async () => {
    expect(
      await run(`export function test(): number {
        function sum(n: number, acc: number): number { if (n === 0) return acc; return sum(n - 1, acc + n); }
        return sum(1000000, 0); }`),
    ).toBe(500000500000);
  });

  it("mutual recursion (both top-level) at 5e5 depth does not overflow", async () => {
    expect(
      await run(`function isEven(n: number): number { if (n === 0) return 1; return isOdd(n - 1); }
function isOdd(n: number): number { if (n === 0) return 0; return isEven(n - 1); }
export function test(): number { return isEven(500000); }`),
    ).toBe(1);
  });
});

describe("#2554 tail-call guards (no invalid Wasm, no exception escape)", () => {
  it("tail call inside try-with-catch: the throw is caught (NOT converted to return_call)", async () => {
    expect(
      await run(`function boom(): number { throw new Error("x"); }
function caller(): number { try { return boom(); } catch (e) { return 99; } }
export function test(): number { return caller(); }`),
    ).toBe(99);
  });

  it("return-type-mismatched call in tail position stays correct", async () => {
    expect(
      await run(`function makeStr(): string { return "hi"; }
function caller(): number { const s = makeStr(); return s.length; }
export function test(): number { return caller(); }`),
    ).toBe(2);
  });
});
