// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1836 — standalone Number<->String conformance.
// Slice: ToNumber(String) octal (0o/0O) and binary (0b/0B) prefix parsing in
// the no-JS-host path (§7.1.4.1 StringToNumber → NonDecimalIntegerLiteral).
// Previously only the hex (0x/0X) prefix was handled; octal/binary returned NaN.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function evalStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors[0]?.message).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#1836 standalone Number() octal/binary prefix", () => {
  it("parses 0o / 0O octal literals", async () => {
    expect(await evalStandalone(`export function test(): number { return Number("0o17"); }`)).toBe(15);
    expect(await evalStandalone(`export function test(): number { return Number("0O17"); }`)).toBe(15);
    expect(await evalStandalone(`export function test(): number { return Number("0o0"); }`)).toBe(0);
    expect(await evalStandalone(`export function test(): number { return Number("0o777"); }`)).toBe(511);
  });

  it("parses 0b / 0B binary literals", async () => {
    expect(await evalStandalone(`export function test(): number { return Number("0b101"); }`)).toBe(5);
    expect(await evalStandalone(`export function test(): number { return Number("0B101"); }`)).toBe(5);
    expect(await evalStandalone(`export function test(): number { return Number("0b0"); }`)).toBe(0);
    expect(await evalStandalone(`export function test(): number { return Number("0b1111"); }`)).toBe(15);
  });

  it("still parses 0x / 0X hex literals (no regression)", async () => {
    expect(await evalStandalone(`export function test(): number { return Number("0x1F"); }`)).toBe(31);
    expect(await evalStandalone(`export function test(): number { return Number("0XfF"); }`)).toBe(255);
  });

  it("returns NaN for digits out of range for the radix", async () => {
    expect(await evalStandalone(`export function test(): number { return Number("0o8"); }`)).toBeNaN();
    expect(await evalStandalone(`export function test(): number { return Number("0b2"); }`)).toBeNaN();
  });

  it("returns NaN when the prefix has no following digit", async () => {
    expect(await evalStandalone(`export function test(): number { return Number("0o"); }`)).toBeNaN();
    expect(await evalStandalone(`export function test(): number { return Number("0b"); }`)).toBeNaN();
  });

  it("returns NaN for a signed non-decimal literal (spec: NonDecimalIntegerLiteral is unsigned)", async () => {
    expect(await evalStandalone(`export function test(): number { return Number("-0x1F"); }`)).toBeNaN();
    expect(await evalStandalone(`export function test(): number { return Number("-0o17"); }`)).toBeNaN();
    expect(await evalStandalone(`export function test(): number { return Number("-0b101"); }`)).toBeNaN();
  });

  it("treats a leading-zero decimal as decimal, not octal", async () => {
    // "08" is a decimal StrNumericLiteral (8), NOT legacy octal.
    expect(await evalStandalone(`export function test(): number { return Number("08"); }`)).toBe(8);
    expect(await evalStandalone(`export function test(): number { return Number("017"); }`)).toBe(17);
  });

  it("parses plain decimal strings unchanged", async () => {
    expect(await evalStandalone(`export function test(): number { return Number("17"); }`)).toBe(17);
    expect(await evalStandalone(`export function test(): number { return Number("0"); }`)).toBe(0);
  });
});
