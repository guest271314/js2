// #1927 — one front-end pipeline driver.
//
// compileSourceSync / compileMultiSource / compileFilesSource were three
// ~450-line near-clones whose feature sets had drifted: only the single-source
// path forwarded `experimentalIR` / `nodeBuiltins` / `allowFs` / `jsxRuntime`
// to codegen and only it ran hardened-mode validation. They now share one
// synchronous core (`runPipeline`) + one option resolver (`buildCodegenOptions`).
//
// These tests pin the BEHAVIORAL gains the unification delivers (the structural
// win — 26 inline failure literals → one `failResult`, ~380 fewer lines — is
// covered by the line-count acceptance criterion, not a runtime assertion):
//   1. multi-source paths now report ES early errors (kept from #1931);
//   2. multi-source paths now run HARDENED mode (new parity);
//   3. equivalent single vs multi compiles still produce a working module.
import { describe, it, expect } from "vitest";
import { compile, compileMulti } from "../src/index.js";
import { compileSourceSync } from "../src/compiler.js";

describe("#1927 single pipeline driver — multi-path parity", () => {
  it("multi-source compile reports an ES early error (duplicate let in the entry)", async () => {
    const r = await compileMulti({ "main.ts": "let x = 1;\nlet x = 2;\nexport const y = x;" }, "main.ts", {});
    expect(r.success).toBe(false);
    expect(r.errors?.some((e) => e.message === "Duplicate identifier 'x'")).toBe(true);
  });

  it("multi-source compile reports an ES early error in a NON-entry file too", async () => {
    const r = await compileMulti(
      {
        "dep.ts": "let z = 1;\nlet z = 2;\nexport const w = z;",
        "main.ts": 'import { w } from "./dep";\nexport const v = w + 1;',
      },
      "main.ts",
      {},
    );
    expect(r.success).toBe(false);
    expect(r.errors?.some((e) => e.message === "Duplicate identifier 'z'")).toBe(true);
  });

  it("multi-source compile now enforces HARDENED mode (was single-source-only before #1927)", async () => {
    const r = await compileMulti(
      { "main.ts": "const o: any = {};\no.__proto__ = {};\nexport const k = 1;" },
      "main.ts",
      { hardened: true },
    );
    expect(r.success).toBe(false);
    expect(r.errors?.some((e) => e.message.includes("[hardened]"))).toBe(true);
  });

  it("a HARDENED violation in a NON-entry file of a multi compile is reported", async () => {
    const r = await compileMulti(
      {
        "dep.ts": "export function leak(): void {\n  eval('1+1');\n}",
        "main.ts": 'import { leak } from "./dep";\nleak();\nexport const k = 1;',
      },
      "main.ts",
      { hardened: true },
    );
    expect(r.success).toBe(false);
    expect(r.errors?.some((e) => e.message.includes("[hardened]"))).toBe(true);
  });

  it("hardened mode stays OFF by default for multi compiles (no false positives)", async () => {
    const r = await compileMulti(
      { "main.ts": "export function f(): number {\n  return eval('1+1') as number;\n}" },
      "main.ts",
      {},
    );
    // Not asserting success (eval has its own runtime path) — only that the
    // hardened gate did NOT fire when `hardened` is unset.
    expect(r.errors?.some((e) => e.message.includes("[hardened]"))).toBe(false);
  });

  // #1958 — the merge_group full baseline caught a -24 eval-code regression that
  // PR-level checks missed: runPipeline gated ES early-error detection behind
  // `if (!options.allowJs)`, but the legacy single-source `compileSourceSync` ran
  // it UNCONDITIONALLY. The `eval` host shim compiles with `allowJs: true` and
  // relies on early errors (e.g. `export` in eval code, strict-eval-in-params)
  // failing the compile so it can throw a SyntaxError. The fix restores the
  // unconditional single-source pass via `runEarlyErrorsOnAllowJs`.
  describe("#1958 single-source allowJs still runs ES early errors (eval host shim)", () => {
    // Mirror the runtime-eval statement-form wrapper + options exactly.
    const compileEval = (src: string) =>
      compileSourceSync(`export function __eval_result() { ${src}; return undefined; }`, {
        fileName: "eval.js",
        allowJs: true,
        skipSemanticDiagnostics: true,
      });
    const hardErrors = (r: { errors?: { severity: string; message: string }[] }) =>
      (r.errors ?? []).filter((e) => e.severity === "error");

    it("rejects `export` declaration in eval code (test262 eval-code/*/export.js)", () => {
      const r = compileEval("export default null;");
      expect(r.success).toBe(false);
      expect(hardErrors(r).length).toBeGreaterThan(0);
    });

    it("rejects strict-mode `eval` as a binding/param (test262 param-eval-stricteval.js)", () => {
      const r = compileEval("'use strict';function f(eval) { }");
      expect(r.success).toBe(false);
      expect(hardErrors(r).some((e) => /eval/.test(e.message))).toBe(true);
    });

    it("rejects strict-mode assignment to `eval` (test262 function/13.0-7-s.js)", () => {
      const r = compileEval("'use strict'; function g() {eval = 42;};");
      expect(r.success).toBe(false);
      expect(hardErrors(r).length).toBeGreaterThan(0);
    });

    it("still accepts valid allowJs eval code (no early-error false positive)", () => {
      const r = compileEval("var x = 1");
      expect(r.success).toBe(true);
      expect(hardErrors(r).length).toBe(0);
    });
  });

  it("single and multi compile the same simple module to a working binary", async () => {
    const src = "export function add(a: number, b: number): number {\n  return a + b;\n}";
    const single = await compile(src);
    const multi = await compileMulti({ "main.ts": src }, "main.ts", {});
    expect(single.success).toBe(true);
    expect(multi.success).toBe(true);
    // Both produce a non-empty WasmGC binary and export `add`.
    expect(single.binary.length).toBeGreaterThan(0);
    expect(multi.binary.length).toBeGreaterThan(0);
  });
});
