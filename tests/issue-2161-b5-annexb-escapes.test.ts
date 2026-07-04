// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2161 family B5 — Annex B identity-escape fallbacks + split-at-end-anchor.
 *
 * Two bounded regex-engine root causes behind ~10 host-pass/standalone-fail rows:
 *
 * (1) Annex B §B.1.4 ExtendedAtom identity escapes. In non-unicode mode an
 *     INCOMPLETE `\x` / `\u` (not followed by the required 2 / 4 hex digits) and
 *     a `\c` not forming a control escape fall through to IdentityEscape — the
 *     literal char — rather than being a SyntaxError. The bytecode pattern parser
 *     was refusing these (`RegexUnsupportedError` → placeholder that trapped at
 *     runtime with "illegal cast"):
 *       - `/\x/` matches the literal `x`; `/\u/` matches the literal `u`;
 *       - `/\c1/` (atom) matches the 3 chars `\`, `c`, `1`;
 *       - inside a character class, Annex B ClassControlLetter additionally
 *         admits digits and `_` (`/[\c1]/` → U+0011, `/[\c_]/` → U+001F).
 *     u/v mode stays strict (a bad `\x`/`\u`/`\c` there is a real SyntaxError).
 *
 * (2) `String.prototype.split` at an end-of-string anchor. The SplitMatch loop
 *     (§22.2.5.2) only tests positions `q < size`, so a zero-width separator
 *     match that STARTS at the end (e.g. `/$/`, `/(?=$)/`) is never seen. The
 *     native `__regex_split` used a forward search that COULD land such a match
 *     at `mstart == size`, producing a spurious trailing "" — `"x".split(/$/)`
 *     returned `["x", ""]` instead of `["x"]`.
 *
 * All standalone with an EMPTY importObject. `skipSemanticDiagnostics` mirrors
 * the test262 runner (these manifest on JS sputnik sources).
 */
async function runStandalone(src: string): Promise<{ leaks: string[]; main: () => unknown }> {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  const leaks = r.imports.map((i) => `${i.module}::${i.name}`).filter((l) => !l.startsWith("wasm:js-string::"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return { leaks, main: instance.exports.main as () => unknown };
}

describe("#2161 B5 — Annex B identity escapes (standalone, host-free)", () => {
  it("/\\x/ (incomplete hex) matches the literal 'x'", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var m = /\\x/.test("x") ? 1 : 0;
        var n = /\\x/.test("y") ? 1 : 0;
        return m * 10 + n; // 10: matches 'x', not 'y'
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(10);
  });

  it("/\\xGG/ (incomplete hex + trailing chars) matches 'xGG' literally", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number { return /\\xGG/.test("xGG") ? 1 : 0; }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });

  it("a valid \\xHH escape is unaffected", async () => {
    const { leaks, main } = await runStandalone(`export function main(): number { return /\\x41/.test("A") ? 1 : 0; }`);
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });

  it("/\\u/ (incomplete) matches the literal 'u'; \\uHHHH unaffected", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var a = /\\u/.test("u") ? 1 : 0;
        var b = /\\u0041/.test("A") ? 1 : 0;
        return a * 10 + b;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(11);
  });

  it("/\\c1/ (atom, \\c not a control escape) matches the literal '\\c1'", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var a = /\\c1/.test("\\\\c1") ? 1 : 0;  // matches backslash,c,1
        var b = /\\c1/.test("c1") ? 1 : 0;      // does NOT match "c1"
        return a * 10 + b;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(10);
  });

  it("/\\cA/ control escape still yields U+0001", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number { return /\\cA/.test(String.fromCharCode(1)) ? 1 : 0; }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });

  it("class ControlLetter admits digit and underscore (/[\\c1]/ → U+0011, /[\\c_]/ → U+001F)", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var a = /[\\c1]/.test(String.fromCharCode(17)) ? 1 : 0;
        var b = /[\\c_]/.test(String.fromCharCode(31)) ? 1 : 0;
        return a * 10 + b;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(11);
  });

  it("class incomplete /[\\x]/ matches literal 'x'", async () => {
    const { leaks, main } = await runStandalone(`export function main(): number { return /[\\x]/.test("x") ? 1 : 0; }`);
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });
});

describe("#2161 B5 — split at an end-of-string anchor (standalone, host-free)", () => {
  it('"x".split(/$/) is ["x"] (no spurious trailing "")', async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var a = "x".split(/$/);
        return a.length === 1 && a[0] === "x" ? 1 : 0;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });

  it('"abc".split(/$/) is ["abc"] and "x".split(/^/) is ["x"]', async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var a = "abc".split(/$/);
        var b = "x".split(/^/);
        return (a.length === 1 && a[0] === "abc" && b.length === 1 && b[0] === "x") ? 1 : 0;
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(1);
  });

  it("multiline $ still splits before an interior newline", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var a = "a\\nb".split(/$/m);
        return a.length; // ["a", "\\nb"] → 2
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(2);
  });

  it("no-regression: ordinary and empty-pattern splits are unchanged", async () => {
    const { leaks, main } = await runStandalone(
      `export function main(): number {
        var a = "a,b,c".split(/,/).length;      // 3
        var b = "abc".split(/(?:)/).length;     // 3 (split into chars)
        var c = "ab".split(/(?=b)/).length;     // 2 (lookahead)
        return a * 100 + b * 10 + c;            // 332
      }`,
    );
    expect(leaks).toEqual([]);
    expect(main()).toBe(332);
  });
});
