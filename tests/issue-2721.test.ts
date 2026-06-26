// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2721 (Part 2) — Standalone JSON number-grammar tightening.
 *
 * The native JSON codec's hand-written number parser was too permissive: it
 * accepted malformed numbers that host `JSON.parse` rejects with a SyntaxError
 * (a leading zero followed by a digit, a decimal point with no fraction digit,
 * an exponent with no digit, a lone `-`). Standalone now throws to match host.
 *
 * (Part 1 — booleans/null `typeof` boxed as a number struct — is substrate-
 * blocked under #1917/#2580 value-rep and split to #2733.)
 *
 * test262 movement: ZERO — test262's JSON.parse runs in host (gc) mode, which
 * already rejects these. This closes the standalone↔host parity gap (#2711).
 */

/** Parse `json` in a standalone module; return the number value, -1 for a
 *  thrown SyntaxError, -2 for any other error. */
async function parseStandalone(json: string): Promise<number> {
  const lit = JSON.stringify(json);
  const src = `export function test(): number {
    try { const v = JSON.parse(${lit}) as any; return (typeof v === "number") ? v : -999; }
    catch (e) { return (e instanceof SyntaxError) ? -1 : -2; }
  }`;
  const r = await compile(src, { fileName: "t.ts", target: "standalone" });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#2721 — standalone JSON rejects malformed numbers (matches host SyntaxError)", () => {
  const malformed = ["01", "00", "0123", "007", "1.", "1.e5", "1e", "1e+", "-", "+1", ".5", "1.2.3"];
  for (const json of malformed) {
    it(`JSON.parse(${JSON.stringify(json)}) throws SyntaxError`, async () => {
      // host rejects too (parity anchor)
      let hostThrew = false;
      try {
        JSON.parse(json);
      } catch {
        hostThrew = true;
      }
      expect(hostThrew).toBe(true);
      expect(await parseStandalone(json)).toBe(-1);
    });
  }
});

describe("#2721 — standalone JSON still accepts valid numbers (no regression)", () => {
  const valid: Array<[string, number]> = [
    ["0", 0],
    ["-0", 0],
    ["10", 10],
    ["123", 123],
    ["0.5", 0.5],
    ["-1.5", -1.5],
    ["1e5", 100000],
    ["1E5", 100000],
    ["0e1", 0],
    ["1.5e-3", 0.0015],
    ["-123.456", -123.456],
    ["0.0", 0],
  ];
  for (const [json, want] of valid) {
    it(`JSON.parse(${JSON.stringify(json)}) === ${want}`, async () => {
      expect(JSON.parse(json)).toBeCloseTo(want, 9); // host parity anchor
      expect(await parseStandalone(json)).toBeCloseTo(want, 9);
    });
  }
});

describe("#2721 — embedded malformed numbers in structures throw", () => {
  async function parseThrows(json: string): Promise<boolean> {
    const lit = JSON.stringify(json);
    const src = `export function test(): number {
      try { JSON.parse(${lit}); return 0; }
      catch (e) { return (e instanceof SyntaxError) ? 1 : -2; }
    }`;
    const r = await compile(src, { fileName: "t.ts", target: "standalone" });
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    return (instance.exports as { test: () => number }).test() === 1;
  }
  for (const json of ["[01]", '{"a":1.}', "[1e]", '{"k":-}', "[007]"]) {
    it(`JSON.parse(${JSON.stringify(json)}) throws`, async () => {
      expect(await parseThrows(json)).toBe(true);
    });
  }

  it("valid structures still parse (member values correct)", async () => {
    const lit = JSON.stringify('{"a":1,"b":2}');
    const src = `export function test(): number {
      const v = JSON.parse(${lit}) as any;
      return ((v.a === 1) && (v.b === 2)) ? 1 : 0;
    }`;
    const r = await compile(src, { fileName: "t.ts", target: "standalone" });
    expect(r.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test: () => number }).test()).toBe(1);
  });
});
