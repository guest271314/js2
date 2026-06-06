// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileAndRunNumber(source: string): Promise<number> {
  const r = await compile(source, {
    fileName: "issue-1900.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });

  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(r.imports.filter((i) => i.module === "env" && i.name === "__to_primitive")).toEqual([]);
  expect(r.imports.filter((i) => i.module === "env" && i.name === "__extern_toString")).toEqual([]);
  expect(WebAssembly.validate(r.binary)).toBe(true);

  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports.test as () => number)();
}

describe("#1900 — standalone native OrdinaryToPrimitive over $Object", () => {
  it("numeric hint calls dynamic valueOf on an open $Object", async () => {
    expect(
      await compileAndRunNumber(`
        export function test(): number {
          const o: any = {};
          const key: any = "valueOf";
          o[key] = function() { return 42; };
          return o - 0;
        }
      `),
    ).toBe(42);
  });

  it("string hint prefers toString for template substitutions", async () => {
    expect(
      await compileAndRunNumber(`
        export function test(): number {
          const o: any = {};
          const valueOfKey: any = "valueOf";
          const toStringKey: any = "toString";
          o[valueOfKey] = function() { return 1; };
          o[toStringKey] = function() { return "X"; };
          return \`\${o}!\` === "X!" ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("falls back from object-returning valueOf to primitive toString", async () => {
    expect(
      await compileAndRunNumber(`
        export function test(): number {
          const o: any = {};
          const valueOfKey: any = "valueOf";
          const toStringKey: any = "toString";
          o[valueOfKey] = function() { return ({} as any); };
          o[toStringKey] = function() { return "17"; };
          return o - 0;
        }
      `),
    ).toBe(17);
  });

  it("throws a real TypeError when both ordinary methods return objects", async () => {
    expect(
      await compileAndRunNumber(`
        export function test(): number {
          const o: any = {};
          const valueOfKey: any = "valueOf";
          const toStringKey: any = "toString";
          o[valueOfKey] = function() { return ({} as any); };
          o[toStringKey] = function() { return ({} as any); };
          try {
            o - 0;
            return 0;
          } catch (e) {
            return e instanceof TypeError ? 1 : 2;
          }
        }
      `),
    ).toBe(1);
  });

  it("keeps Symbol.toPrimitive deferred until symbol-keyed $Object lookup exists", async () => {
    const r = await compile(
      `
        export function test(): number {
          const o: any = {};
          o[Symbol.toPrimitive] = function(_hint: string) { return 99; };
          return o - 0;
        }
      `,
      { fileName: "issue-1900-symbol.ts", target: "standalone", skipSemanticDiagnostics: true },
    );

    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join("\n")).toContain("#1472");
    expect(r.imports.filter((i) => i.module === "env" && i.name === "__to_primitive")).toEqual([]);
  });
});
