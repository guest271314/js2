// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { compileAndInstantiate } from "../src/runtime.js";

// #3118 — `new Object(primitive)` was ignoring its argument and always building
// an empty object (`__new_plain_object`), so `new Object(42)` stringified to
// "[object Object]" instead of "42". Per §20.1.1.1 the `new` and call forms are
// spec-identical: both return ToObject(value). The fix routes `new Object(arg)`
// through the same `emitObjectCoercion` helper the call form uses, so a
// primitive arg boxes to its Number/String/Boolean/BigInt wrapper.
//
// Host lane (compileAndInstantiate = real host globals): these are the genuine
// main-realm semantics a JS host observes.

async function run<T>(src: string): Promise<T> {
  const exports = await compileAndInstantiate(src);
  return (exports as { f: () => T }).f();
}

describe("#3118 new Object(primitive) ToObject wrapper", () => {
  describe("stringification reflects the boxed primitive", () => {
    it("String(new Object(42)) === '42'", async () => {
      expect(await run(`export function f(): string { return String(new Object(42)); }`)).toBe("42");
    });

    it("String(new Object(true)) === 'true'", async () => {
      expect(await run(`export function f(): string { return String(new Object(true)); }`)).toBe("true");
    });

    it("String(new Object('hi')) === 'hi'", async () => {
      expect(await run(`export function f(): string { return String(new Object("hi")); }`)).toBe("hi");
    });

    it("new Object(42).toString() === '42'", async () => {
      expect(await run(`export function f(): string { const o: any = new Object(42); return o.toString(); }`)).toBe(
        "42",
      );
    });
  });

  describe("wrapper identity + valueOf", () => {
    it("new Object(42).valueOf() === 42", async () => {
      expect(await run(`export function f(): number { const o: any = new Object(42); return o.valueOf(); }`)).toBe(42);
    });

    it("new Object(42) instanceof Number", async () => {
      expect(
        await run(
          `export function f(): number { const o: any = new Object(42); return (o instanceof Number) ? 1 : 0; }`,
        ),
      ).toBe(1);
    });

    it("typeof new Object(42) === 'object'", async () => {
      expect(await run(`export function f(): string { return typeof new Object(42); }`)).toBe("object");
    });
  });

  describe("String.prototype method borrowed onto new Object(primitive) — the S15.5.4.x cluster", () => {
    it("charCodeAt reads the boxed number's string (borrow)", async () => {
      expect(
        await run(`export function f(): number {
          const i: any = new Object(42);
          i.charCodeAt = String.prototype.charCodeAt;
          return i.charCodeAt(false) * 100 + i.charCodeAt(true); // "42": '4'=52, '2'=50
        }`),
      ).toBe(5250);
    });

    it("toLowerCase on new Object('AB')", async () => {
      expect(
        await run(`export function f(): string {
          const i: any = new Object("AB");
          i.toLowerCase = String.prototype.toLowerCase;
          return i.toLowerCase();
        }`),
      ).toBe("ab");
    });

    it("indexOf on new Object('abc')", async () => {
      expect(
        await run(`export function f(): number {
          const i: any = new Object("abcb");
          i.indexOf = String.prototype.indexOf;
          return i.indexOf("b");
        }`),
      ).toBe(1);
    });
  });

  describe("spec-identity with the call form + edge cases (no regressions)", () => {
    it("new Object() (no arg) → fresh plain object", async () => {
      expect(
        await run(`export function f(): string { const o: any = new Object(); o.x = 5; return typeof o + ":" + o.x; }`),
      ).toBe("object:5");
    });

    it("new Object(obj) returns the argument unchanged (identity)", async () => {
      expect(
        await run(`export function f(): number {
          const a: any = { v: 7 };
          const b: any = new Object(a);
          return (a === b ? 1 : 0) * 10 + b.v;
        }`),
      ).toBe(17);
    });

    it("new Object(arr) returns the array unchanged", async () => {
      expect(
        await run(`export function f(): number {
          const a: any = [1, 2, 3];
          const o: any = new Object(a);
          return (o === a ? 1 : 0) * 10 + o.length;
        }`),
      ).toBe(13);
    });

    it("new Object(null) → fresh plain object", async () => {
      expect(
        await run(
          `export function f(): string { const o: any = new Object(null); o.y = 3; return typeof o + ":" + o.y; }`,
        ),
      ).toBe("object:3");
    });

    it("Object(7) call form still boxes to '7'", async () => {
      expect(await run(`export function f(): string { return String(Object(7)); }`)).toBe("7");
    });
  });

  describe("byte-inertness", () => {
    it("a program with no new Object(...) compiles unaffected", async () => {
      // Sanity: the change is scoped to the new Object(...) arm — a program
      // that never constructs Object compiles and runs normally.
      const r = await compile(`export function f(): number { return [1, 2, 3].map((x) => x * 2)[2]; }`, {});
      expect(r.success).toBe(true);
    });
  });
});
