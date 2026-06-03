// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

function assertNoJsonHostImports(result) {
  const labels = result.imports.map((i) => i.module + "::" + i.name);
  expect(labels.filter((l) => /env::JSON_(parse|stringify)/.test(l))).toEqual([]);
}

async function runStandalone(body) {
  const src = "export function test(): number {\n" + body + "\n}";
  const result = await compile(src, { target: "standalone" });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  assertNoJsonHostImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return instance.exports.test();
}

describe("#1599 Phase 2 — runtime JSON.stringify(string) standalone", () => {
  it("quotes a plain runtime string", async () => {
    const r = await runStandalone(`
      let s: string = "hel";
      s = s + "lo";
      return JSON.stringify(s) === '"hello"' ? 1 : 0;
    `);
    expect(r).toBe(1);
  });

  it("escapes quote and backslash", async () => {
    // build 'a"b\c' at runtime: 'a"' + 'b' + '\\' + 'c'
    const r = await runStandalone(`
      let s: string = 'a"';
      s = s + 'b' + '\\\\' + 'c';
      return JSON.stringify(s) === '"a\\\\"b\\\\\\\\c"' ? 1 : 0;
    `);
    expect(r).toBe(1);
  });

  it("escapes the short control chars b t n f r", async () => {
    const r = await runStandalone(`
      let s: string = "\\b\\t";
      s = s + "\\n\\f\\r";
      return JSON.stringify(s) === '"\\\\b\\\\t\\\\n\\\\f\\\\r"' ? 1 : 0;
    `);
    expect(r).toBe(1);
  });

  it("escapes other control chars as uXXXX", async () => {
    const r = await runStandalone(`
      let s: string = "\\u0000\\u0001";
      s = s + "\\u001f";
      return JSON.stringify(s) === '"\\\\u0000\\\\u0001\\\\u001f"' ? 1 : 0;
    `);
    expect(r).toBe(1);
  });

  it("returns just quotes for the empty runtime string", async () => {
    const r = await runStandalone(`
      let s: string = "x";
      s = s.slice(1);
      return JSON.stringify(s) === '""' ? 1 : 0;
    `);
    expect(r).toBe(1);
  });

  it("does not pull in env::JSON_stringify for runtime string stringify", async () => {
    const result = await compile("export function test(s: string): string { return JSON.stringify(s); }", {
      target: "standalone",
    });
    expect(result.success).toBe(true);
    assertNoJsonHostImports(result);
  });
});
