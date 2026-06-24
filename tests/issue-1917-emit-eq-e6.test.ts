// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1917 equality finale, slice E6 — `emitAnyEqFromExternTemps`.
 *
 * The standalone externref-vs-externref loose-equality tail (two opaque `any`
 * operands that are not eqref-identical) boxes both externrefs to `$AnyValue` via
 * `__any_from_extern` and calls the keystone `__any_eq` helper (the native
 * §7.2.15 IsLooselyEqual, #2081). That construction — the LAST direct keystone
 * `__any_eq` call left in binary-ops.ts after E3 — moved into the coercion engine
 * as `emitAnyEqFromExternTemps`. This is a byte-neutral code-motion; these cases
 * regression-guard the OBSERVABLE standalone behaviour (and that the host lane is
 * unchanged).
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

// Two opaque `any` externrefs, string vs number — the native String<->Number
// loose-eq arm (#2081). On BOTH lanes `"1" == 1` is true.
const strNumLoose = `function f(a: any, b: any): boolean { return a == b; }
export function test(): number { const s: any = "1"; const n: any = 1; return f(s, n) ? 1 : 0; }`;

// `!=` form exercises the negation (i32.eqz) tail.
const strNumNeq = `function f(a: any, b: any): boolean { return a != b; }
export function test(): number { const s: any = "1"; const n: any = 1; return f(s, n) ? 1 : 0; }`;

// Two `any` objects with the SAME identity — the eqref-identity arm (not the
// extern tail), so loose-eq is true.
const objIdentity = `function f(a: any, b: any): boolean { return a == b; }
export function test(): number { const o: any = {}; const p: any = o; return f(o, p) ? 1 : 0; }`;

describe("#1917 E6 — emitAnyEqFromExternTemps (standalone externref loose-eq tail)", () => {
  for (const standalone of [false, true]) {
    const lane = standalone ? "standalone" : "host";
    it(`"1" == 1 is true [${lane}]`, async () => expect(await run(strNumLoose, standalone)).toBe(1));
    it(`"1" != 1 is false [${lane}]`, async () => expect(await run(strNumNeq, standalone)).toBe(0));
    it(`same-identity object == is true [${lane}]`, async () => expect(await run(objIdentity, standalone)).toBe(1));
  }
});
