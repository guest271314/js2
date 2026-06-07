// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1712 — compiled acorn differential AST acceptance.
 *
 * The reusable diff ignores position fields. This test additionally strips
 * compiled-only `sourceFile: null` metadata before comparing; node-acorn does
 * not emit that field for the same parse options, and it is not AST structure.
 */
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const REPRESENTATIVE_JS = `
x;
y;
z;
{
  nested;
  label: target;
}
/foo+/gi;
flag ? yes : no;
`;

describe("#1712 — compiled acorn differential AST acceptance", () => {
  it("parses a representative JS fixture structurally equal to node-acorn", { timeout: 180_000 }, () => {
    const script = `
      import { readFileSync } from "node:fs";
      import { compile } from "./src/index.ts";
      import { buildImports, wrapExports } from "./src/runtime.ts";
      import { setupAcorn } from "./tests/dogfood/setup-acorn.mjs";
      import { diffAst } from "./tests/dogfood/ast-diff.mjs";

      function normalizeAst(value) {
        if (value === null || typeof value !== "object") return value;
        if (Array.isArray(value)) return value.map(normalizeAst);
        const out = {};
        for (const [key, child] of Object.entries(value)) {
          if (key === "sourceFile" && child === null) continue;
          out[key] = normalizeAst(child);
        }
        return out;
      }

      (async () => {
        const fixture = ${JSON.stringify(REPRESENTATIVE_JS)};
        const { entryModulePath } = setupAcorn();
        const oracle = await import(entryModulePath + "?issue1712=" + Date.now());
        const acornSource = readFileSync(entryModulePath, "utf-8");
        const compiled = await compile(acornSource, { fileName: "acorn.mjs" });
        if (!compiled.success || !compiled.binary) {
          console.error(JSON.stringify({ errors: compiled.errors?.slice(0, 10) }, null, 2));
          process.exit(1);
        }

        const imports = buildImports(compiled.imports ?? [], undefined, compiled.stringPool ?? []);
        const { instance } = await WebAssembly.instantiate(compiled.binary, imports);
        imports.setExports?.(instance.exports);
        const compiledAcorn = wrapExports(instance.exports, { signatures: compiled.exportSignatures });

        const parseOptions = { ecmaVersion: 2022, sourceType: "script" };
        const expected = normalizeAst(oracle.parse(fixture, parseOptions));
        const actual = normalizeAst(compiledAcorn.parse(fixture, parseOptions));
        const diff = diffAst(expected, actual, { ignorePositions: true, maxDivergences: 5 });
        if (!diff.equal) {
          console.error(JSON.stringify(diff, null, 2));
          process.exit(1);
        }
      })().catch((error) => {
        console.error(error?.stack || error);
        process.exit(1);
      });
    `;

    const out = execFileSync("npx", ["tsx", "--eval", script], {
      cwd: process.cwd(),
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
    expect(out).toBe("");
  });
});
