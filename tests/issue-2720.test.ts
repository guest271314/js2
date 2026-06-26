// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2720 — standalone RegExp non-Unicode `/i` case folding.
 *
 * Before this fix the standalone (native) regex backend folded `/i` ASCII-only,
 * so `/Ä/i` did not match `ä`, Greek/Cyrillic case pairs disagreed with the
 * host, etc. §22.2.2.9.3 Canonicalize (non-Unicode, IgnoreCase) folds each code
 * unit through the Unicode default UPPERCASE mapping. The fold is resolved at
 * COMPILE TIME (host as spec oracle, same pattern as #1911/#1912) and desugared
 * to plain unit CLASS/CHAR ops, so the emitted module stays pure Wasm with no
 * runtime Unicode tables.
 *
 * (`u`/`v` mode already used simple case folding via the host-oracle in
 * `unicode.ts` since #1911; the u-mode rows below are regression guards.)
 *
 * The reference-VM (parse→compile→vm) is unit-tested broadly in
 * tests/regex-bytecode.test.ts; this file dual-runs the END-TO-END standalone
 * Wasm VM against the native engine for the case-fold surface.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function standaloneTest(pattern: string, flags: string, input: string): Promise<boolean> {
  const inLit = JSON.stringify(input);
  const src = `export function run(): boolean { return /${pattern}/${flags}.test(${inLit}); }`;
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const hostRegex = WebAssembly.Module.imports(mod).filter((i) => /RegExp/.test(i.name));
  expect(hostRegex, "no RegExp host import in standalone").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { run(): number }).run() !== 0;
}

const CASES: Array<{ p: string; f: string; inputs: string[] }> = [
  // Non-Unicode /i — Latin-1 supplement case pairs (the core #2720 gap).
  { p: "Ä", f: "i", inputs: ["ä", "Ä", "a", "ö"] },
  { p: "ä", f: "i", inputs: ["Ä", "ä", "A"] },
  { p: "café", f: "i", inputs: ["CAFÉ", "Café", "cafe"] },
  // Greek — including final sigma ς folding to Σ/σ.
  { p: "Σ", f: "i", inputs: ["σ", "ς", "Σ", "s"] },
  { p: "ωμέγα", f: "i", inputs: ["ΩΜΈΓΑ", "ωμέγα", "omega"] },
  // Cyrillic.
  { p: "Привет", f: "i", inputs: ["ПРИВЕТ", "привет", "Hello"] },
  // Class ranges fold their members case-insensitively.
  { p: "[À-Ý]+", f: "i", inputs: ["àáâ", "ÀÁÂ", "abc"] },
  { p: "[α-ω]+", f: "i", inputs: ["ΑΒΓ", "αβγ", "xyz"] },
  { p: "[А-Я]+", f: "i", inputs: ["мир", "МИР", "abc"] },
  // Negated class /i must exclude BOTH cases of its members.
  { p: "[^a]", f: "i", inputs: ["A", "a", "b"] },
  { p: "[^Ä]", f: "i", inputs: ["ä", "Ä", "x"] },
  // §22.2.2.9.3 ASCII-guard: these must NOT fold to ASCII.
  { p: "K", f: "i", inputs: ["K", "K", "k"] }, // Kelvin sign
  { p: "ſ", f: "i", inputs: ["s", "S", "ſ"] }, // long s
  { p: "straße", f: "i", inputs: ["STRASSE", "straße", "STRAßE"] }, // ß → "SS"
  // Plain ASCII /i (no regression).
  { p: "abc", f: "i", inputs: ["ABC", "AbC", "abc", "xyz"] },
  { p: "[a-z]+", f: "i", inputs: ["HELLO", "hello", "123"] },
  // u/v mode regression guards (already correct via #1911 host-oracle).
  { p: "Ä", f: "iu", inputs: ["ä", "Ä"] },
  { p: "σ", f: "iu", inputs: ["Σ", "ς"] },
  { p: "[\\u{1F600}-\\u{1F602}]", f: "u", inputs: ["\u{1F601}", "\u{1F603}"] },
];

describe("#2720 standalone RegExp non-Unicode /i case folding — dual-run vs native", () => {
  for (const { p, f, inputs } of CASES) {
    for (const input of inputs) {
      it(`/${p}/${f} on ${JSON.stringify(input)}`, async () => {
        const expected = new RegExp(p, f).test(input);
        expect(await standaloneTest(p, f, input)).toBe(expected);
      });
    }
  }

  it("inline (?i:…) modifier applies full non-Unicode folding to its subtree", async () => {
    // `(?i:Ä)` folds, the trailing `x` stays case-sensitive.
    expect(await standaloneTest("(?i:Ä)x", "", "äx")).toBe(true);
    expect(await standaloneTest("(?i:Ä)x", "", "äX")).toBe(false);
  });
});
