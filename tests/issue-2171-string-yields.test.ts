// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2171 (SF-4 of #2157) — native generators with **string** yields in
 * standalone.
 *
 * The Wasm-native generator (#1665/#2079) carried numeric-only payloads: the
 * result struct's `value` field and the state spills were f64, so a string
 * yield bailed to the #680 diagnostic. This slice keys the result struct (and
 * the for-of loop variable) on a per-generator element ValType — f64 for the
 * numeric path (unchanged) or the native `$AnyString` ref for a generator whose
 * yields are all strings.
 *
 * Scope: uniformly-string-typed generators with straight-line / non-spilling
 * bodies (`yield "a"; yield "b"`). Deferred (documented follow-ups): mixed-type
 * yields (`yield 1; yield "a"`), string generators that spill a live local
 * across a suspension (e.g. a `while`-loop induction var — bails cleanly),
 * `.next(strValue)` / `.return(strValue)` (the sent/abrupt fields stay f64), and
 * spread / Array.from of a string generator.
 *
 * Loop-var typing note: the generator carries the correct string value; reading
 * it via `.length` / `===` / `+` requires the loop variable's static type to be
 * `string`, so the examples annotate `Generator<string>` (matching idiomatic TS).
 *
 * Every case compiles standalone with ZERO host imports.
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

describe("#2171 native generator with string yields", () => {
  it("for-of count over string yields", async () => {
    expect(
      await runStandalone(`function* g(): Generator<string> { yield "a"; yield "b"; }
export function test(): number { let n = 0; for (const v of g()) n++; return n; }`),
    ).toBe(2);
  });

  it("sum of yielded string lengths (value carried correctly)", async () => {
    expect(
      await runStandalone(`function* g(): Generator<string> { yield "ab"; yield "c"; }
export function test(): number { let n = 0; for (const v of g()) n += v.length; return n; }`),
    ).toBe(3); // 2 + 1
  });

  it("concatenation of yielded strings", async () => {
    expect(
      await runStandalone(`function* g(): Generator<string> { yield "ab"; yield "c"; }
export function test(): number { let acc = ""; for (const v of g()) acc = acc + v; return acc.length; }`),
    ).toBe(3); // "abc"
  });

  it("string equality on a yielded value", async () => {
    expect(
      await runStandalone(`function* g(): Generator<string> { yield "ab"; yield "c"; }
export function test(): number { for (const v of g()) { const s: string = v; return s === "ab" ? 1 : 0; } return -1; }`),
    ).toBe(1);
  });

  it("three string yields", async () => {
    expect(
      await runStandalone(`function* g(): Generator<string> { yield "x"; yield "yy"; yield "zzz"; }
export function test(): number { let n = 0; for (const v of g()) n += v.length; return n; }`),
    ).toBe(6); // 1 + 2 + 3
  });
});

describe("#2171 regression — numeric generators unchanged", () => {
  it("numeric for-of sums correctly", async () => {
    expect(
      await runStandalone(`function* g(){ yield 1; yield 2; yield 3; }
export function test(): number { let s = 0; for (const v of g()) s += v; return s; }`),
    ).toBe(6);
  });
  it("numeric while-loop generator (control flow + spill) unchanged", async () => {
    expect(
      await runStandalone(`function* g(){ let i = 0; while (i < 4) { yield i; i++; } }
export function test(): number { let s = 0; for (const v of g()) s += v; return s; }`),
    ).toBe(6); // 0+1+2+3
  });
});
