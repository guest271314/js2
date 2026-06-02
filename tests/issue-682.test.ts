// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const HOST_REGEXP_IMPORT_RE =
  /RegExp_|__regex_symbol_call|__proto_method_call|wasm:js-string|string_constants|^env::string_(match|matchAll|search|replace|replaceAll|split)$/;

async function runStandaloneNumber(source: string): Promise<number> {
  const r = await compile(source, { fileName: "issue-682.ts", target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);

  const mod = await WebAssembly.compile(r.binary);
  const leaks = WebAssembly.Module.imports(mod)
    .filter((i) => HOST_REGEXP_IMPORT_RE.test(`${i.module}::${i.name}`))
    .map((i) => `${i.module}::${i.name}`);
  expect(leaks).toEqual([]);

  const instance = await WebAssembly.instantiate(mod, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#682 standalone RegExp literal-substring backend", () => {
  it("runs a regex literal .test without JS-host RegExp imports", async () => {
    const value = await runStandaloneNumber(`
      export function test(): number {
        return /abc/.test("zzabczz") ? 1 : 0;
      }
    `);

    expect(value).toBe(1);
  });

  it("returns false when the static literal pattern is absent", async () => {
    const value = await runStandaloneNumber(`
      export function test(): number {
        const re = /abc/;
        return re.test("ab") ? 1 : 0;
      }
    `);

    expect(value).toBe(0);
  });

  it("runs new RegExp with a static literal pattern", async () => {
    const value = await runStandaloneNumber(`
      export function test(): number {
        const re = new RegExp("needle");
        return re.test("hay needle stack") ? 1 : 0;
      }
    `);

    expect(value).toBe(1);
  });

  it("runs RegExp(...) without new for a static literal pattern", async () => {
    const value = await runStandaloneNumber(`
      export function test(): number {
        const re = RegExp("needle");
        return re.test("haystack") ? 1 : 0;
      }
    `);

    expect(value).toBe(0);
  });

  it("runs RegExp.prototype.test.call with a static backend receiver", async () => {
    const value = await runStandaloneNumber(`
      export function test(): number {
        return RegExp.prototype.test.call(/abc/, "zzabc") ? 1 : 0;
      }
    `);

    expect(value).toBe(1);
  });

  it("does not intercept a user-defined RegExp function", async () => {
    const value = await runStandaloneNumber(`
      function RegExp(pattern: string): number {
        return pattern.length;
      }

      export function test(): number {
        return RegExp("needle");
      }
    `);

    expect(value).toBe(6);
  });

  it("does not intercept a user-defined RegExp class .test method", async () => {
    const value = await runStandaloneNumber(`
      class RegExp {
        test(value: string): boolean {
          return value.length === 3;
        }
      }

      export function test(): number {
        const re = new RegExp();
        return re.test("abc") ? 1 : 0;
      }
    `);

    expect(value).toBe(1);
  });

  it("treats escaped regexp metacharacters as literal characters", async () => {
    const value = await runStandaloneNumber(`
      export function test(): number {
        return /a\\.b/.test("xa.bx") ? 1 : 0;
      }
    `);

    expect(value).toBe(1);
  });

  it("refuses unsupported regexp syntax explicitly", async () => {
    const r = await compile(`export function test(): boolean { return /\\d+/.test("123"); }`, {
      fileName: "issue-682.ts",
      target: "standalone",
    });

    expect(r.success).toBe(false);
    expect(r.errors.some((e) => /#682\/#1474/.test(e.message))).toBe(true);
    expect(r.imports.some((i) => HOST_REGEXP_IMPORT_RE.test(`${i.module}::${i.name}`))).toBe(false);
  });

  it("refuses stateful flags until lastIndex semantics are implemented", async () => {
    const r = await compile(`export function test(): boolean { return /abc/g.test("abcabc"); }`, {
      fileName: "issue-682.ts",
      target: "standalone",
    });

    expect(r.success).toBe(false);
    expect(r.errors.some((e) => /flags "g"/.test(e.message) && /#682\/#1474/.test(e.message))).toBe(true);
    expect(r.imports.some((i) => HOST_REGEXP_IMPORT_RE.test(`${i.module}::${i.name}`))).toBe(false);
  });

  it("refuses direct RegExp symbol protocol calls without JS-host imports", async () => {
    const r = await compile(`export function test(): number { const re = /abc/; return re[Symbol.search]("zabc"); }`, {
      fileName: "issue-682.ts",
      target: "standalone",
    });

    expect(r.success).toBe(false);
    expect(r.errors.some((e) => /symbol protocol calls/.test(e.message) && /#682\/#1474/.test(e.message))).toBe(true);
    expect(r.imports.some((i) => HOST_REGEXP_IMPORT_RE.test(`${i.module}::${i.name}`))).toBe(false);
  });

  it("refuses unsupported RegExp prototype calls without the host prototype bridge", async () => {
    const r = await compile(
      `export function test(): boolean { return RegExp.prototype.exec.call(/abc/, "abc") !== null; }`,
      {
        fileName: "issue-682.ts",
        target: "standalone",
      },
    );

    expect(r.success).toBe(false);
    expect(r.errors.some((e) => /RegExp\.prototype\.exec\.call/.test(e.message) && /#682\/#1474/.test(e.message))).toBe(
      true,
    );
    expect(r.imports.some((i) => HOST_REGEXP_IMPORT_RE.test(`${i.module}::${i.name}`))).toBe(false);
  });

  it("refuses opaque RegExp receivers not created by the standalone backend", async () => {
    const r = await compile(`export function test(re: RegExp): boolean { return re.test("abc"); }`, {
      fileName: "issue-682.ts",
      target: "standalone",
    });

    expect(r.success).toBe(false);
    expect(
      r.errors.some(
        (e) => /RegExp values not created by this standalone backend/.test(e.message) && /#682\/#1474/.test(e.message),
      ),
    ).toBe(true);
    expect(r.imports.some((i) => HOST_REGEXP_IMPORT_RE.test(`${i.module}::${i.name}`))).toBe(false);
  });

  it("refuses RegExp-consuming string methods without JS-host string imports", async () => {
    const r = await compile(`export function test(s: string): string { return s.replace(/a/g, "b"); }`, {
      fileName: "issue-682.ts",
      target: "standalone",
    });

    expect(r.success).toBe(false);
    expect(r.errors.some((e) => /String\.prototype\.replace/.test(e.message) && /#1474/.test(e.message))).toBe(true);
    expect(r.imports.some((i) => HOST_REGEXP_IMPORT_RE.test(`${i.module}::${i.name}`))).toBe(false);
  });

  it("refuses RegExp-building string methods without JS-host string imports", async () => {
    const r = await compile(`export function test(s: string): number { return s.search("a"); }`, {
      fileName: "issue-682.ts",
      target: "standalone",
    });

    expect(r.success).toBe(false);
    expect(r.errors.some((e) => /String\.prototype\.search/.test(e.message) && /#1474/.test(e.message))).toBe(true);
    expect(r.imports.some((i) => HOST_REGEXP_IMPORT_RE.test(`${i.module}::${i.name}`))).toBe(false);
  });
});
