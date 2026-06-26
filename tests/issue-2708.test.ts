import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

// #2708 — primitive & literal edge cases.
//
// (a) Legacy string escape sequences are valid in sloppy mode (Annex B §12.9.4):
//     - NonOctalDecimalEscapeSequence: \8 \9  → the literal digit
//     - LegacyOctalEscapeSequence:     \nnn   → the encoded code point
//     They must remain a SyntaxError in strict mode.
//
// (b) A regexp literal's `\uNNNN` atom escape is preserved verbatim in
//     `RegExp#source` (compiler-level; the matching test-harness fix lives in
//     tests/test262-runner.ts resolveUnicodeEscapes).

async function run(src: string): Promise<number> {
  const exports = await compileToWasm(src);
  return (exports as Record<string, () => number>).test();
}

async function compileError(src: string): Promise<string | null> {
  const r = await compile(src);
  if (r.success && !r.errors.some((e) => e.severity === "error")) return null;
  return (r.errors.find((e) => e.severity === "error") ?? r.errors[0])?.message ?? "compile failed";
}

describe("#2708 (a) legacy string escapes — sloppy mode", () => {
  it("\\8 decodes to '8'", async () => {
    expect(await run(`export function test(): number { return "\\8" === "8" ? 1 : 0; }`)).toBe(1);
  });

  it("\\9 decodes to '9'", async () => {
    expect(await run(`export function test(): number { return "\\9" === "9" ? 1 : 0; }`)).toBe(1);
  });

  it("legacy octal \\251 decodes to U+00A9 (169)", async () => {
    expect(await run(`export function test(): number { return "\\251".charCodeAt(0); }`)).toBe(169);
  });

  it("legacy octal \\101 decodes to 'A' (65)", async () => {
    expect(await run(`export function test(): number { return "\\101".charCodeAt(0); }`)).toBe(65);
  });

  it("\\0 NUL escape still works (not a legacy octal)", async () => {
    expect(await run(`export function test(): number { return "\\0".charCodeAt(0); }`)).toBe(0);
  });

  it("escaped backslash before 8 is not a legacy escape", async () => {
    // "\\8" in TS source = backslash + '8' (length 2), char0 = 92
    expect(await run(`export function test(): number { return "\\\\8".charCodeAt(0); }`)).toBe(92);
  });
});

describe("#2708 (a) legacy string escapes — strict mode is a SyntaxError", () => {
  it("\\8 rejected under 'use strict'", async () => {
    const err = await compileError(`"use strict";\nexport function test(): number { return "\\8" === "8" ? 1 : 0; }`);
    expect(err).not.toBeNull();
  });

  it("legacy octal \\251 rejected under 'use strict'", async () => {
    const err = await compileError(`"use strict";\nexport function test(): number { return "\\251".charCodeAt(0); }`);
    expect(err).not.toBeNull();
  });

  it("strict mode still accepts the \\0 NUL escape", async () => {
    const err = await compileError(`"use strict";\nexport function test(): number { return "\\0".charCodeAt(0); }`);
    expect(err).toBeNull();
  });
});

describe("#2708 (b) regexp \\u atom escape — RegExp#source preserved", () => {
  it("/\\u0041/ matches 'A'", async () => {
    expect(await run(`export function test(): number { return /\\u0041/.test("A") ? 1 : 0; }`)).toBe(1);
  });

  it("/\\u0041/.source is the raw 6-char pattern", async () => {
    expect(await run(`export function test(): number { return /\\u0041/.source.length; }`)).toBe(6);
    expect(await run(`export function test(): number { return /\\u0041/.source === "\\\\u0041" ? 1 : 0; }`)).toBe(1);
  });
});
