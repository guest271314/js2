// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2049 — `o?.m(args)` was never routed to the optional-call codegen.
//
// In the TS AST the `?.` of `o?.m(args)` sits on the inner
// PropertyAccessExpression, not on the CallExpression — only `o.m?.(args)`
// sets `CallExpression.questionDotToken`. The routing gate in
// `compileCallExpression` keyed on the call token, so `o?.m(args)` fell into the
// regular method-call path, which (a) evaluated arguments unconditionally even
// when the receiver was nullish and (b) emitted a receiver deref that trapped
// (`ref.as_non_null to a null reference`) on a null class instance.
//
// Fix: gate on `ts.isOptionalChain(expr)`, strip receiver nullability before
// method resolution (the receiver is `K | null` by construction), and add a
// closure-field fallback that delegates to `compileCallablePropertyCall`.
//
// The undefined-vs-NaN representation of the short-circuit *result value* is a
// separate concern tracked as #2051, so these tests assert side-effect /
// no-trap / non-null-result behavior, not the exact undefined encoding.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

async function run(src: string, fn = "test"): Promise<number> {
  const r = await compile(src, { fileName: "test.ts" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
  return (instance.exports as Record<string, () => number>)[fn]!();
}

describe("#2049 o?.m(args) routes to optional-call codegen", () => {
  it("closure-field receiver: nullish chain does NOT evaluate the argument", async () => {
    // `o?.f(mark(5))` with null `o` must short-circuit before `mark` runs.
    const src = `
let log = 0;
function mark(k: number): number { log = log * 10 + k; return k; }
type Obj = { f: (x: number) => number; v: number };
function getObj(b: boolean): Obj | null { if (b) return { f: (x: number) => x * 2, v: 9 }; return null; }
export function test(): number { log = 0; const o = getObj(false); const r = o?.f(mark(5)); return log; }`;
    expect(await run(src)).toBe(0); // mark never called
  });

  it("class-method receiver: nullish chain does NOT trap", async () => {
    // Regular path emitted `ref.as_non_null` on a null class instance → uncatchable trap.
    const src = `
let log = 0;
function mark(k: number): number { log = log * 10 + k; return k; }
class K { m(x: number): number { return x + 1; } }
function getK(b: boolean): K | null { return b ? new K() : null; }
export function test(): number { log = 0; const k = getK(false); const r = k?.m(mark(7)); return log; }`;
    expect(await run(src)).toBe(0); // no trap; mark never called
  });

  it("closure-field receiver: non-null chain calls and returns the real value", async () => {
    const src = `
let log = 0;
function mark(k: number): number { log = log * 10 + k; return k; }
type Obj = { f: (x: number) => number; v: number };
function getObj(b: boolean): Obj | null { if (b) return { f: (x: number) => x * 2, v: 9 }; return null; }
export function test(): number { log = 0; const o = getObj(true); const r = o?.f(mark(5)); return (r as number) * 100 + log; }`;
    expect(await run(src)).toBe(1005); // mark(5)→5, f(5)=10, 10*100+5
  });

  it("class-method receiver: non-null chain calls and returns the real value", async () => {
    const src = `
let log = 0;
function mark(k: number): number { log = log * 10 + k; return k; }
class K { m(x: number): number { return x + 1; } }
function getK(b: boolean): K | null { return b ? new K() : null; }
export function test(): number { log = 0; const k = getK(true); const r = k?.m(mark(7)); return (r as number) * 100 + log; }`;
    expect(await run(src)).toBe(807); // mark(7)→7, m(7)=8, 8*100+7
  });

  it("dynamic-call form o.f?.(x) and o?.f?.(x) still work (no regression)", async () => {
    const src = `
type O = { f: (x: number) => number };
function g(b: boolean): O | null { return b ? { f: (x: number) => x * 2 } : null; }
export function pure(): number { const o = g(true)!; return o.f?.(3) ?? -1; }
export function both(): number { const o = g(true); return o?.f?.(3) ?? -1; }`;
    expect(await run(src, "pure")).toBe(6);
    expect(await run(src, "both")).toBe(6);
  });

  it("void-returning method via optional chain runs its side effect when non-null", async () => {
    const src = `
class K { p = 0; m(): void { this.p = 7; } }
function g(b: boolean): K | null { return b ? new K() : null; }
export function test(): number { const k = g(true); k?.m(); return k!.p; }`;
    expect(await run(src)).toBe(7);
  });
});
