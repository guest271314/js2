// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3281 (subtask of #3182, WAVE-C) — compileNewExpression decomposition smoke test.
//
// Slice 1 lifted the built-in global constructor dispatch band (~1,096 LOC:
// Promise, the Number/String/Boolean wrapper objects, the Error family,
// AggregateError, SuppressedError, Object, Proxy, Function, Date, and the
// TypedArray constructors) VERBATIM out of `compileNewExpression`
// (src/codegen/expressions/new-super.ts) into
// `src/codegen/expressions/new-builtin-globals.ts`
// (`tryCompileBuiltinGlobalNew`, guarded by the `NEW_GLOBAL_FALLTHROUGH`
// sentinel).
//
// Slice 2 lifted the indexed built-in constructor band (~630 LOC: ArrayBuffer
// incl. resizable, DataView, Array) VERBATIM into
// `src/codegen/expressions/new-indexed.ts` (`tryCompileIndexedBuiltinNew`,
// guarded by `NEW_INDEXED_FALLTHROUGH`), bringing `compileNewExpression` under
// 1,500 LOC.
//
// Both relocations are byte-identical — proved via
// scripts/prove-emit-identity.mjs (IDENTICAL across all 39 gc/standalone/wasi
// emits) — so this suite is armor + a reachability check, NOT a behavioural
// change: it confirms the extracted arms still dispatch end to end.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(body: string): Promise<{ result: number; envImports: string[] }> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const envImports = WebAssembly.Module.imports(new WebAssembly.Module(r.binary!))
    .filter((i) => i.module === "env")
    .map((i) => i.name);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  const result = (instance.exports as { test(): number }).test();
  return { result, envImports };
}

async function compilesOn(body: string, target: "gc" | "standalone" | "wasi"): Promise<boolean> {
  const src = `export function test(): number { ${body} }`;
  const r = await compile(src, { target });
  return r.success && !!r.binary;
}

describe("#3281 slice 1 — TypedArray ctors survive extraction (standalone-native)", () => {
  it("new Uint8Array(n) → a zero-filled view of the requested length, zero host imports", async () => {
    const { result, envImports } = await runStandalone("const a = new Uint8Array(4); return a.length;");
    expect(result).toBe(4);
    expect(envImports).toEqual([]); // pure native path
  });

  it("new Int32Array([...]) → copy constructor reads back element by index", async () => {
    const { result, envImports } = await runStandalone("const a = new Int32Array([10, 20, 30]); return a[1];");
    expect(result).toBe(20);
    expect(envImports).toEqual([]);
  });

  it("new Float64Array(n) → indexed store/read round-trips", async () => {
    const { result } = await runStandalone("const a = new Float64Array(2); a[0] = 3; a[1] = 4; return a[0] + a[1];");
    expect(result).toBe(7);
  });
});

describe("#3281 slice 2 — indexed built-in ctors survive extraction (standalone-native)", () => {
  it("new ArrayBuffer(n) → byteLength reflects the requested size, zero host imports", async () => {
    const { result, envImports } = await runStandalone("const b = new ArrayBuffer(8); return b.byteLength;");
    expect(result).toBe(8);
    expect(envImports).toEqual([]); // pure native path
  });

  it("new DataView(buffer) → setInt32/getInt32 round-trips over the backing buffer", async () => {
    const { result, envImports } = await runStandalone(
      "const b = new ArrayBuffer(8); const dv = new DataView(b); dv.setInt32(0, 42); return dv.getInt32(0);",
    );
    expect(result).toBe(42);
    expect(envImports).toEqual([]);
  });

  it("new Array(n) → length reflects the requested size", async () => {
    const { result } = await runStandalone("const a = new Array(3); return a.length;");
    expect(result).toBe(3);
  });

  it("new Array() → push + indexed read round-trips", async () => {
    const { result } = await runStandalone(
      "const a: number[] = new Array(); a.push(5); a.push(7); return a[0] + a[1];",
    );
    expect(result).toBe(12);
  });
});

describe("#3281 slice 1 — built-in global ctors still dispatch (compile reachability)", () => {
  const cases: Array<[string, string]> = [
    ['new Error("boom")', 'const e = new Error("boom"); return (e as any).message === "boom" ? 1 : 0;'],
    ["new RangeError(msg)", 'const r = new RangeError("x"); return 1;'],
    ["new Number(x)", "const n = new Number(5); return 1;"],
    ["new String(x)", 'const s = new String("hi"); return 1;'],
    ["new Boolean(x)", "const b = new Boolean(true); return 1;"],
    ["new Object()", "const o = new Object(); return 1;"],
    ["new Date(y, m, d)", "const d = new Date(2020, 0, 1); return d.getFullYear();"],
    ["new Promise(executor)", "const p = new Promise((res) => res(1)); return 1;"],
  ];
  for (const [label, body] of cases) {
    it(`${label} compiles in gc mode`, async () => {
      expect(await compilesOn(body, "gc")).toBe(true);
    });
  }
});
