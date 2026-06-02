// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

function assertNoJsonHostImports(result: Awaited<ReturnType<typeof compile>>): void {
  const labels = result.imports.map((i) => `${i.module}::${i.name}`);
  expect(labels.filter((l) => /env::JSON_(parse|stringify)/.test(l))).toEqual([]);
}

async function compileStandalone(src: string): Promise<Record<string, unknown>> {
  const result = await compile(src, { target: "standalone" });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  assertNoJsonHostImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return instance.exports as Record<string, unknown>;
}

describe("#1599 standalone JSON literal slice", () => {
  it("stringifies a static object/array graph without env::JSON_stringify", async () => {
    const exports = await compileStandalone(`
      export function test(): number {
        const s = JSON.stringify({ a: 1, b: [2, 3] });
        return s === '{"a":1,"b":[2,3]}' ? 1 : 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("parses a static object literal and reads a property without env::JSON_parse", async () => {
    const exports = await compileStandalone(`
      export function test(): number {
        return JSON.parse('{"x":42}').x === 42 ? 1 : 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("parses a static array literal and reads an index without env::JSON_parse", async () => {
    const exports = await compileStandalone(`
      export function test(): number {
        return JSON.parse('[1,2,3]')[1] === 2 ? 1 : 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("stringifies static string literals with JSON escaping", async () => {
    const exports = await compileStandalone(`
      export function test(): number {
        return JSON.stringify("hello\\n") === '"hello\\\\n"' ? 1 : 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("parses static primitive JSON text without env::JSON_parse", async () => {
    const exports = await compileStandalone(`
      export function test(): number {
        return JSON.parse('null') === null && JSON.parse('42') === 42 ? 1 : 0;
      }
    `);
    expect((exports.test as () => number)()).toBe(1);
  });

  it("stringifies dynamic numbers through the native standalone number formatter", async () => {
    const exports = await compileStandalone(`
      export function test(n: number): number {
        return JSON.stringify(n) === "42" ? 1 : 0;
      }
    `);
    expect((exports.test as (n: number) => number)(42)).toBe(1);
  });

  it("still refuses dynamic JSON.parse text in standalone", async () => {
    const result = await compile(`export function test(s: string): number { return JSON.parse(s).x; }`, {
      target: "standalone",
    });
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => /#1599/.test(e.message))).toBe(true);
    assertNoJsonHostImports(result);
  });
});
