// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("compile error: " + (r.errors[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
  return (instance.exports.run as () => number)();
}

describe("#1748 readonly array struct fields", () => {
  it("readonly number[] nested struct field reads back on indexed access", async () => {
    expect(
      await run(`
interface FE { code: readonly number[]; arity: number; }
interface PG { functions: readonly FE[]; entry: number; }
export function run(): number {
  const program: PG = { functions: [{ code: [7, 2], arity: 1 }], entry: 0 };
  const entryFn = program.functions[program.entry];
  return entryFn.code[0];
}`),
    ).toBe(7);
  });

  it("ReadonlyArray<T> field form lowers identically to T[]", async () => {
    expect(
      await run(`
interface FE { code: ReadonlyArray<number>; arity: number; }
export function run(): number {
  const f: FE = { code: [9, 2], arity: 1 };
  return f.code[0];
}`),
    ).toBe(9);
  });

  it("readonly string[] field preserves element identity", async () => {
    expect(
      await run(`
interface S { names: readonly string[]; }
export function run(): number {
  const s: S = { names: ["a", "bb"] };
  return s.names[1].length;
}`),
    ).toBe(2);
  });

  it("plain (non-readonly) nested array field still works", async () => {
    expect(
      await run(`
interface FE { code: number[]; arity: number; }
interface PG { functions: FE[]; entry: number; }
export function run(): number {
  const program: PG = { functions: [{ code: [7, 2], arity: 1 }], entry: 0 };
  return program.functions[program.entry].code[0];
}`),
    ).toBe(7);
  });
});
