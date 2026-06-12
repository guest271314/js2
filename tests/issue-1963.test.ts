// #1963 — native `__str_isWhitespace` (used by trim/trimStart/trimEnd) only
// recognised 0x09-0x0D, 0x20, 0xA0, 0xFEFF and missed most Unicode whitespace
// (U+1680, U+2000-200A, U+2028/29, U+202F, U+205F, U+3000), so e.g.
// "　x".trim() kept length 2 in native mode (node: 1). The set now mirrors
// the regex `\s` SPACE table = §22.1.3.32 TrimString's WhiteSpace+LineTerminator.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function runFast(source: string, exportName = "test"): Promise<number> {
  const result = await compile(source, { fast: true });
  if (!result.success) {
    throw new Error(result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n"));
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  if (imports.setExports) {
    imports.setExports(instance.exports as Record<string, Function>);
  }
  return (instance.exports[exportName] as Function)() as number;
}

/** `length` of `("<ws>x<ws>").trim()` in native mode — must equal Node's. */
async function trimLen(jsStringLiteralBody: string): Promise<number> {
  return runFast(`export function test(): number { return ${jsStringLiteralBody}.trim().length; }`);
}

describe("#1963 native trim covers the full Unicode whitespace set", () => {
  // Each: a literal wrapping a single 'x' in the named whitespace code unit.
  // `.trim()` must reduce it to length 1, matching Node.
  const cases: Array<[string, string]> = [
    ["U+0020 SPACE", '" x "'],
    ["U+0009 TAB / U+000A LF / U+000D CR", '"\\t\\nx\\r"'],
    ["U+00A0 NBSP", '"\\u00A0x\\u00A0"'],
    ["U+1680 OGHAM SPACE MARK", '"\\u1680x\\u1680"'],
    ["U+2000 EN QUAD", '"\\u2000x\\u2000"'],
    ["U+2003 EM SPACE", '"\\u2003x\\u2003"'],
    ["U+200A HAIR SPACE", '"\\u200Ax\\u200A"'],
    ["U+2028 LINE SEPARATOR", '"\\u2028x\\u2028"'],
    ["U+2029 PARAGRAPH SEPARATOR", '"\\u2029x\\u2029"'],
    ["U+202F NARROW NBSP", '"\\u202Fx\\u202F"'],
    ["U+205F MEDIUM MATH SPACE", '"\\u205Fx\\u205F"'],
    ["U+3000 IDEOGRAPHIC SPACE", '"\\u3000x\\u3000"'],
    ["U+FEFF ZWNBSP / BOM", '"\\uFEFFx\\uFEFF"'],
    ["mixed run", '"\\u3000\\u00A0\\t x \\u2003\\uFEFF"'],
  ];

  for (const [name, literal] of cases) {
    it(`trims ${name} → length 1`, async () => {
      // Each literal is a single 'x' wrapped in the named whitespace, so the
      // native (Node) trim is length 1 by construction; the assertion below
      // checks the compiled native-strings path produces the same.
      expect(await trimLen(literal)).toBe(1);
    });
  }

  it("does NOT trim non-whitespace (ASCII fast path unchanged)", async () => {
    // 'y' and 'z' are not whitespace — only the surrounding spaces go.
    expect(await trimLen('"  yz  "')).toBe(2);
    // A bare non-whitespace string is unchanged.
    expect(await runFast(`export function test(): number { return "abc".trim().length; }`)).toBe(3);
  });

  it("trimStart / trimEnd honour the extended set too", async () => {
    // Shared __str_isWhitespace, so both directions get the fix.
    expect(await runFast(`export function test(): number { return "\\u3000\\u2003x".trimStart().length; }`)).toBe(1);
    expect(await runFast(`export function test(): number { return "x\\u202F\\uFEFF".trimEnd().length; }`)).toBe(1);
  });
});
