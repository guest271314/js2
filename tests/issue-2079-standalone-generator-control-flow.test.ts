// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2079 — standalone native generators with yields inside control flow
 * (#680 "Phase 2").
 *
 * Before this slice, the Wasm-native generator lowering
 * (`src/codegen/generators-native.ts`) only modeled a LINEAR sequence of
 * sequential numeric yields: any `while`/`for`/`do-while` loop or `if`/`else`
 * containing a `yield` fell into `buildNativeGeneratorPlan` returning `null`,
 * which in standalone/WASI mode is a hard compile error ("native generator
 * lowering currently supports only sequential numeric yields"). Loops and
 * conditionals are the dominant generator shape, so this blocked a large slice
 * of the standalone iterator/generator conformance gap (#2157).
 *
 * Phase 2 lowers structured control flow to a state graph driven by a
 * trampoline in the generated resume function: a yield/return `br`s out with
 * the result; a loop back-edge / if-join / sequential boundary sets the state
 * field and re-enters the dispatch. Loop-carried locals spill to the state
 * struct so they survive each suspension.
 *
 * It also hardens the late-import funcindex hazard (#1899 class): the resume
 * function reserves its module slot with a placeholder BEFORE its body emits
 * (Phase-2 bodies can lazily register numeric-operator helpers like `%`, which
 * would otherwise shift the resume function past its captured funcIdx and make
 * every baked `call` — the for-of driver, `.next()` — hit the helper instead).
 *
 * Every case must compile standalone with ZERO host imports and run correctly.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2079 standalone native generators — yields in control flow", () => {
  it("while loop with a yield", async () => {
    expect(
      await runStandalone(`function* g(){ let i = 0; while (i < 3) { yield i; i++; } }
export function test(): number { let s = 0; for (const v of g()) s += v; return s; }`),
    ).toBe(3); // 0+1+2
  });

  it("for loop with a yield and a param bound", async () => {
    expect(
      await runStandalone(`function* g(n: number){ for (let i = 0; i < n; i++) { yield i * 2; } }
export function test(): number { let s = 0; for (const v of g(4)) s += v; return s; }`),
    ).toBe(12); // 0+2+4+6
  });

  it("do-while loop with a yield", async () => {
    expect(
      await runStandalone(`function* g(){ let i = 0; do { yield i; i++; } while (i < 3); }
export function test(): number { let s = 0; for (const v of g()) s += v; return s; }`),
    ).toBe(3);
  });

  it("if/else with yields in both branches", async () => {
    const src = (n: number) => `function* g(n: number){ if (n > 0) { yield 1; yield 2; } else { yield 9; } }
export function test(): number { let s = 0; for (const v of g(${n})) s += v; return s; }`;
    expect(await runStandalone(src(1))).toBe(3);
    expect(await runStandalone(src(0))).toBe(9);
  });

  it("yields before and after a loop", async () => {
    expect(
      await runStandalone(`function* g(){ yield 10; let i = 0; while (i < 2) { yield i; i++; } yield 20; }
export function test(): number { let s = 0; for (const v of g()) s += v; return s; }`),
    ).toBe(31); // 10 + 0 + 1 + 20
  });

  it("nested loops with a yield (loop-carried spills round-trip)", async () => {
    expect(
      await runStandalone(`function* g(){ for (let i = 0; i < 2; i++) { for (let j = 0; j < 2; j++) { yield i*10 + j; } } }
export function test(): number { let s = 0; for (const v of g()) s += v; return s; }`),
    ).toBe(22); // 0,1,10,11
  });

  it("if (no else) with a yield inside a loop — exercises the funcindex placeholder", async () => {
    // `i % 2` lazily registers the f64-modulo helper while the resume body is
    // being emitted; without the reserved-slot fix the for-of driver's baked
    // `call` would target the modulo helper instead of the resume function.
    expect(
      await runStandalone(`function* g(){ for (let i = 0; i < 5; i++) { if (i % 2 === 0) yield i; } }
export function test(): number { let s = 0; for (const v of g()) s += v; return s; }`),
    ).toBe(6); // 0 + 2 + 4
  });

  it("return inside a loop completes the generator", async () => {
    expect(
      await runStandalone(`function* g(){ let i = 0; while (true) { if (i === 3) return 99; yield i; i++; } }
export function test(): number { let s = 0; for (const v of g()) s += v; return s; }`),
    ).toBe(3); // yields 0,1,2 then returns (return value not part of for-of sum)
  });

  it("manual .next() over a while-loop generator", async () => {
    expect(
      await runStandalone(`function* g(){ let i = 0; while (i < 3) { yield i; i++; } }
export function test(): number {
  const it = g(); let s = 0; let r = it.next();
  while (!r.done) { s += r.value as number; r = it.next(); }
  return s;
}`),
    ).toBe(3);
  });

  it(".next(value) sent into a loop binds across suspension", async () => {
    expect(
      await runStandalone(`function* g(){ let total = 0; while (true) { const x = yield total; total += x; } }
export function test(): number {
  const it = g();
  it.next();
  it.next(10);
  const r = it.next(5);
  return (r.value as number);
}`),
    ).toBe(15);
  });

  it(".return() early-completes an infinite loop generator", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number, number, unknown> {
  let i = 0; while (i < 100) { yield i; i++; } return 0;
}
export function test(): number {
  const it = g();
  it.next(); it.next();
  const r = it.return(42);
  return (r.done ? 1 : 0) * 1000 + (r.value as number);
}`),
    ).toBe(1042);
  });

  it("infinite generator consumed partially via .next()", async () => {
    expect(
      await runStandalone(`function* g(){ let i = 0; while (true) { yield i; i++; } }
export function test(): number {
  const it = g(); let s = 0;
  for (let k = 0; k < 5; k++) { s += it.next().value as number; }
  return s;
}`),
    ).toBe(10); // 0+1+2+3+4
  });

  it("regression: a purely-sequential generator still lowers natively", async () => {
    expect(
      await runStandalone(`function* g(){ yield 1; yield 2; return 3; }
export function test(): number { let s = 0; for (const v of g()) s += v; return s; }`),
    ).toBe(3);
  });
});
