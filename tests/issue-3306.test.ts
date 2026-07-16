// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #3306 — standalone ToNumber of a toString-only object (§7.1.1.1
 * OrdinaryToPrimitive → §7.1.4.1 StringToNumber).
 *
 * `tryToStringFallback` (type-coercion.ts) found and invoked the `toString`
 * closure but every result converter treated a `ref`-kind return as
 * "object → drop + NaN" — under nativeStrings that is exactly the NATIVE
 * string struct `toString(){ return "7" }` returns, so `+obj` executed the
 * method and threw away the "7". Fixed by the shared
 * `refResultStringToF64Instrs` (runtime `ref.test $AnyString` →
 * `__str_to_number`; genuine object returns keep NaN), wired into all three
 * converter sites. Host lane byte-identical (strings are externref there and
 * already unboxed).
 */

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "t.ts", target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const envImports = (r.imports ?? []).filter((i) => i.module === "env").map((i) => i.name);
  expect(envImports, "must stay host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  return (instance.exports.test as () => unknown)();
}

describe("#3306 — toString-only object ToNumber (standalone)", () => {
  it("+{toString(){return '7'}} === 7 (unary plus)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { var arg = { toString: function() { return "7"; } }; return +arg; }`,
      ),
    ).toBe(7);
  });

  it("Number(toString-only object) converts via StringToNumber", async () => {
    expect(
      await runStandalone(
        `export function test(): number { var arg = { toString: function() { return "  12.5 "; } }; return Number(arg); }`,
      ),
    ).toBe(12.5);
  });

  it("toString returning a non-numeric string yields NaN", async () => {
    expect(
      await runStandalone(
        `export function test(): number { var arg = { toString: function() { return "abc"; } }; var n = +arg; return n !== n ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("toString returning a NUMBER passes through", async () => {
    expect(
      await runStandalone(
        `export function test(): number { var arg = { toString: function() { return 5; } }; return +arg; }`,
      ),
    ).toBe(5);
  });

  it("Date.prototype.setTime coerces a toString-only argument", async () => {
    expect(
      await runStandalone(
        `export function test(): number { var d = new Date(0); var arg = { toString: function() { return "5"; } }; return d.setTime(arg); }`,
      ),
    ).toBe(5);
  });

  it("valueOf still wins over toString for hint number (§7.1.1.1 order)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { var arg = { valueOf: function() { return 3; }, toString: function() { return "9"; } }; return +arg; }`,
      ),
    ).toBe(3);
  });

  it("valueOf-returns-object → toString fallthrough (#2891) unchanged", async () => {
    expect(
      await runStandalone(
        `export function test(): number { var arg = { valueOf: function() { return {}; }, toString: function() { return "7"; } }; return +arg; }`,
      ),
    ).toBe(7);
  });

  it("new Date(y, m) with toString-only args runs coercion in order", async () => {
    expect(
      await runStandalone(`
var log = "";
export function test(): number {
  var year = { toString: function() { log += "year"; return 1970; } };
  var month = { toString: function() { log += "month"; return 0; } };
  var d = new Date(year, month);
  return log === "yearmonth" && d.getFullYear() === 1970 ? 1 : 2;
}`),
    ).toBe(1);
  });
});
