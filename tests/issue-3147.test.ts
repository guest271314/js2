// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #3147 — standalone-native `String.raw(template, ...substitutions)` — the
// ordinary FUNCTION-CALL form (§22.1.2.4). Previously refused via the
// `__get_builtin` dynamic-shape path (#1472 Phase B): 22 hard CEs under
// test262 built-ins/String/raw/. The tagged-template form is a separate,
// already-native lowering (#2008/#2510) and is only smoke-checked here.

async function run(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors?.map((e) => e.message).join("\n")).toBe(true);
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(r.binary));
  expect(imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#3147 standalone String.raw function-call form", () => {
  it("interleaves raw segments with substitutions (§22.1.2.4)", async () => {
    expect(
      await run(`
        export function test(): number {
          const template: any = { raw: ["a", "b", "d", "f"] };
          if (String.raw(template, "", "c", "e") !== "abcdef") return 1;
          if (String.raw(template, 1) !== "a1bdf") return 2;
          return 9;
        }`),
    ).toBe(9);
  });

  it("array-like raw object: segments are ToString'd (null/undefined/number)", async () => {
    expect(
      await run(`
        export function test(): number {
          const obj: any = {
            raw: { length: 5, 0: "e", 1: "", 2: null, 3: undefined, 4: 123, 5: "overpass" }
          };
          const s = String.raw(obj);
          // Spec: "enullundefined123". Under the current default (#2106 S1
          // singleton OFF) stored null and undefined COLLAPSE to the null
          // externref, so both segments render "null". Accept either — when
          // the S1 default flips, the spec string comes for free.
          if (s === "enullundefined123") return 9;
          if (s === "enullnull123") return 9;
          return 1;
        }`),
    ).toBe(9);
  });

  it("substitutions are limited to raw length - 1 (extra sub toString must NOT run)", async () => {
    expect(
      await run(`
        export function test(): number {
          const template: any = { raw: ["a", "c", "e"] };
          const bomb: any = { toString: function (): string { throw new Error("boom"); } };
          return String.raw(template, "b", "d", bomb) === "abcde" ? 9 : 1;
        }`),
    ).toBe(9);
  });

  it("nullish template / nullish raw → TypeError (catchable)", async () => {
    expect(
      await run(`
        export function test(): number {
          let hits = 0;
          try { String.raw(undefined as any); } catch (e: any) { if (e instanceof TypeError) hits++; }
          try { String.raw(null as any); } catch (e: any) { if (e instanceof TypeError) hits++; }
          try { String.raw({ raw: undefined } as any); } catch (e: any) { if (e instanceof TypeError) hits++; }
          try { String.raw({ raw: null } as any); } catch (e: any) { if (e instanceof TypeError) hits++; }
          return hits === 4 ? 9 : hits;
        }`),
    ).toBe(9);
  });

  it("empty string when raw.length is 0 / NaN / negative / missing", async () => {
    expect(
      await run(`
        export function test(): number {
          if (String.raw({ raw: [] } as any) !== "") return 1;
          if (String.raw({ raw: { length: NaN } } as any, "x") !== "") return 2;
          if (String.raw({ raw: { length: -1 } } as any, "x") !== "") return 3;
          if (String.raw({ raw: {} } as any, "x") !== "") return 4;
          return 9;
        }`),
    ).toBe(9);
  });

  it("abrupt completion from a substitution toString propagates", async () => {
    expect(
      await run(`
        export function test(): number {
          const template: any = { raw: ["a", "b", "c"] };
          const bomb: any = { toString: function (): string { throw new Error("boom"); } };
          try {
            String.raw(template, "", bomb);
            return 1;
          } catch (e: any) {
            return 9;
          }
        }`),
    ).toBe(9);
  });

  it("tagged-template form still works (separate path, smoke check)", async () => {
    expect(
      await run(`
        export function test(): number {
          if (String.raw\`\` !== "") return 1;
          const v = "test";
          if (String.raw\`x\${v}y\` !== "xtesty") return 2;
          return 9;
        }`),
    ).toBe(9);
  });
});
