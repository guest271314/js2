// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1917 equality finale, slice E3 (any/any) — `emitStrictEq` / `emitLooseEq`.
 *
 * The four `any`-operand equality arms (`==`/`===`/`!=`/`!==`) of
 * `compileAnyBinaryDispatch` were extracted into `emitLooseEq`/`emitStrictEq`
 * (coercion-engine.ts) — the dispatch layer that selects the `__any_eq` /
 * `__any_strict_eq` keystone helper (which owns the tag-5 classifier), boxes the
 * operands, and applies the `!=`/`!==` negation. This is a byte-neutral
 * extraction; these end-to-end cases regression-guard the OBSERVABLE equality
 * behaviour on both the JS-host (gc) and standalone lanes.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(src: string, standalone: boolean): Promise<unknown> {
  const r = await compile(src, standalone ? { fileName: "t.ts", target: "standalone" } : { fileName: "t.ts" });
  expect(r.success, r.success ? "" : `CE: ${r.errors?.[0]?.message}`).toBe(true);
  const importObj = standalone ? {} : (r.importObject ?? {});
  const { instance } = await WebAssembly.instantiate(r.binary, importObj as WebAssembly.Imports);
  return (instance.exports as { test(): unknown }).test();
}

// `==` performs JS loose-equality coercion: 1 == "1" is true.
const looseEq = `function eq(a: any, b: any): boolean { return a == b; }
export function test(): number { return eq(1, "1") ? 1 : 0; }`;

// `===` is strict: 1 === 1 true, 1 === "1" false.
const strictEqSame = `function eq(a: any, b: any): boolean { return a === b; }
export function test(): number { return eq(1, 1) ? 1 : 0; }`;
const strictEqDiff = `function eq(a: any, b: any): boolean { return a === b; }
export function test(): number { return eq(1, "1") ? 1 : 0; }`;

// `!=` / `!==` are the negated arms.
const looseNeq = `function ne(a: any, b: any): boolean { return a != b; }
export function test(): number { return ne(1, 2) ? 1 : 0; }`;
const strictNeq = `function ne(a: any, b: any): boolean { return a !== b; }
export function test(): number { return ne(1, "1") ? 1 : 0; }`;

// A combined program exercising all four operators on several operand shapes.
const combined = `function f(a: any, b: any): number {
  let n = 0;
  if (a == b) n += 1;
  if (a === b) n += 2;
  if (a != b) n += 4;
  if (a !== b) n += 8;
  return n;
}
export function test(): number {
  return f(3, 3.0) + f("x", "x") + f(1, 2);
}`;

// The combined program's RESULT differs by lane because of a PRE-EXISTING (not
// E3-introduced) standalone classifier gap, verified byte-identical on
// origin/main: on the JS-host lane `3 === 3.0` is true (== true(1), === true(2)
// → 3), but the standalone numeric-tag classifier reports `3 === 3.0` FALSE (==
// true(1), != true(4), !== true(8) → 13) — a known deferred-fix item
// (#1987/#2040 family). E3 is a byte-neutral dispatch extraction, so each lane's
// established value is pinned here as a regression guard, NOT "corrected".
//   host:       f(3,3.0)=3  + f("x","x")=3 + f(1,2)=12 = 18
//   standalone: f(3,3.0)=13 + f("x","x")=3 + f(1,2)=12 = 28
const combinedExpected = { host: 18, standalone: 28 } as const;

describe("#1917 E3 — emitStrictEq / emitLooseEq (any/any equality dispatch)", () => {
  for (const standalone of [false, true]) {
    const lane = standalone ? "standalone" : "host";
    it(`== coerces (1 == "1" true) [${lane}]`, async () => expect(await run(looseEq, standalone)).toBe(1));
    it(`=== same-type true (1 === 1) [${lane}]`, async () => expect(await run(strictEqSame, standalone)).toBe(1));
    it(`=== cross-type false (1 === "1") [${lane}]`, async () => expect(await run(strictEqDiff, standalone)).toBe(0));
    it(`!= true (1 != 2) [${lane}]`, async () => expect(await run(looseNeq, standalone)).toBe(1));
    it(`!== true (1 !== "1") [${lane}]`, async () => expect(await run(strictNeq, standalone)).toBe(1));
    it(`combined ==/===/!=/!== [${lane}]`, async () =>
      expect(await run(combined, standalone)).toBe(combinedExpected[lane]));
  }
});
