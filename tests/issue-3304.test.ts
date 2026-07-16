// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #3304 — standalone primitive-string bracket indexing (§10.4.3.5
 * StringGetOwnProperty).
 *
 * `"XYZ"[2]` on a statically-string-typed receiver fell through
 * `compileElementAccess` to the generic `__extern_get` dynamic read (which has
 * no `$NativeString` arm) and answered null: `s[2] === "Z"` was false and
 * `s[2].length` null-derefed, while `s.charAt(2)` worked. Fix: the #1910 R4
 * String-wrapper indexed-read arm (property-access.ts) now ALSO fires for a
 * primitive-string receiver (same oracle predicate #3027 uses), keeping the
 * identical `__to_primitive` → `__str_flatten` → `__str_charAt` emission.
 *
 * Out-of-range keeps the sanctioned #1910 R4 approximation ("" per charAt
 * §22.1.3.1, not the spec's undefined) — documented in the issue file.
 */

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "t.ts", target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const envImports = (r.imports ?? []).filter((i) => i.module === "env").map((i) => i.name);
  expect(envImports, "must stay host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  return (instance.exports.test as () => unknown)();
}

describe("#3304 — standalone primitive-string bracket indexing", () => {
  it("s[i] with a computed index compares === against a literal", async () => {
    expect(
      await runStandalone(`export function test(): number { var s = "XYZ"; return s[s.length - 1] === "Z" ? 1 : 0; }`),
    ).toBe(1);
  });

  it("direct literal indexing works", async () => {
    expect(await runStandalone(`export function test(): number { return "XYZ"[2] === "Z" ? 1 : 0; }`)).toBe(1);
  });

  it("the indexed result is a usable 1-char string (.length, .charCodeAt)", async () => {
    expect(
      await runStandalone(`export function test(): number {
  var s = "XYZ";
  if (s[2].length !== 1) return 10;
  if (s[2].charCodeAt(0) !== 90) return 11;
  if (s[2] !== s.charAt(2)) return 12;
  return 1;
}`),
    ).toBe(1);
  });

  it("indexing a concat-built (non-flat) string works", async () => {
    expect(
      await runStandalone(
        `export function test(): number { var s = "AB" + "CZ"; return s[s.length - 1] === "Z" ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("the #3174 residual toISOString row idiom works end-to-end", async () => {
    expect(
      await runStandalone(`export function test(): number {
  var dateStr = (new Date(0)).toISOString();
  return dateStr[dateStr.length - 1] === "Z" ? 1 : 0;
}`),
    ).toBe(1);
  });

  it("String-wrapper indexing (#1910 R4) is unchanged", async () => {
    // NOTE: no `as any` — the arm gates on the STATIC receiver type (wrapper
    // or primitive string); an any-typed receiver stays on the dynamic-read
    // path (the documented #3304 follow-up).
    expect(
      await runStandalone(`export function test(): number { var w = new String("ab"); return w[0] === "a" ? 1 : 0; }`),
    ).toBe(1);
  });
});
