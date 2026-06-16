/**
 * #1261 — eval tiering classifier.
 *
 * `classifyEvalTier` computes a module's worst-case eval tier at compile time
 * (read-only; no behaviour change). These tests pin the per-tier classification
 * and the strict-mode invariant (TS/ESM never reach tier 5).
 */
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { EvalTier, classifyEvalTier } from "../src/codegen/eval-tiering.js";

/**
 * Build an in-memory Program + checker and classify the eval tier of `src`.
 *
 * `fileName` + `scriptKind` control strict-mode detection: a `.ts` file or one
 * with a module marker (import/export) is strict; a bare `.js` script with no
 * "use strict" prologue is sloppy. No default lib is provided, so an `eval`
 * identifier resolves to no symbol → treated as the global eval (matches the
 * `isGlobalEvalIdentifier` heuristic).
 */
function tierOf(src: string, fileName = "t.ts", scriptKind = ts.ScriptKind.TS): EvalTier {
  const sf = ts.createSourceFile(fileName, src, ts.ScriptTarget.ES2022, true, scriptKind);
  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    allowJs: true,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  };
  const host: ts.CompilerHost = {
    getSourceFile: (n) => (n === fileName ? sf : undefined),
    writeFile: () => {},
    getDefaultLibFileName: () => "lib.d.ts",
    getCurrentDirectory: () => ".",
    getCanonicalFileName: (n) => n,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: () => false,
    readFile: () => undefined,
  };
  const program = ts.createProgram([fileName], compilerOptions, host);
  const checker = program.getTypeChecker();
  const sourceFile = program.getSourceFile(fileName) ?? sf;
  return classifyEvalTier(sourceFile, checker);
}

describe("#1261 classifyEvalTier", () => {
  it("tier 1: no eval anywhere", () => {
    expect(tierOf("export function f(x: number): number { return x + 1; }")).toBe(EvalTier.NoEval);
  });

  it("tier 1: an identifier merely named eval-ish but never called is not eval", () => {
    expect(tierOf("export const evaluate = (x: number) => x; evaluate(2);")).toBe(EvalTier.NoEval);
  });

  it("tier 2: direct eval of a static string literal", () => {
    expect(tierOf('export const x = eval("1 + 1");')).toBe(EvalTier.StaticLiteral);
  });

  it("tier 2: static string concatenation argument", () => {
    expect(tierOf('export const x = eval("1 +" + " 1");')).toBe(EvalTier.StaticLiteral);
  });

  it("tier 2: indirect eval of a static literal is still inlined", () => {
    expect(tierOf('export const x = (0, eval)("1 + 1");')).toBe(EvalTier.StaticLiteral);
  });

  it("tier 3: indirect eval of a dynamic argument", () => {
    expect(tierOf("export function f(s: string) { return (0, eval)(s); }")).toBe(EvalTier.Indirect);
  });

  it("tier 4: direct eval of a dynamic argument in a strict (TS) module", () => {
    expect(tierOf("export function f(s: string) { return eval(s); }")).toBe(EvalTier.DirectStrict);
  });

  it("tier 5: direct eval of a dynamic argument in a sloppy script", () => {
    // Bare .js script, no module markers, no "use strict" → sloppy mode.
    expect(tierOf("function f(s) { return eval(s); }", "t.js", ts.ScriptKind.JS)).toBe(EvalTier.DirectSloppy);
  });

  it('tier 4: a sloppy-looking script with a "use strict" prologue is strict', () => {
    expect(tierOf('"use strict";\nfunction f(s) { return eval(s); }', "t.js", ts.ScriptKind.JS)).toBe(
      EvalTier.DirectStrict,
    );
  });

  it("module worst-case: a literal eval and a dynamic direct eval together → tier 4", () => {
    const src = ['export const a = eval("1 + 1");', "export function f(s: string) { return eval(s); }"].join("\n");
    expect(tierOf(src)).toBe(EvalTier.DirectStrict);
  });

  it("strict-mode invariant: a TS source never classifies above tier 4", () => {
    const src = "export function f(s: string) { return eval(s); }";
    expect(tierOf(src)).toBeLessThanOrEqual(EvalTier.DirectStrict);
  });

  it("a locally-shadowed eval parameter is not the global eval", () => {
    // `eval` is a local parameter here, so the call is `none` → no eval tier.
    expect(tierOf("export function f(eval: (s: string) => unknown, s: string) { return eval(s); }")).toBe(
      EvalTier.NoEval,
    );
  });
});
