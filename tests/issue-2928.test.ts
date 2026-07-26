// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2928 E2 canary — self-compile the E1 interpreter into a standalone WasmGC
// module, then run ESTree -> bytecode -> dispatch entirely inside Wasm.
//
// E6 owns the separately linked runtime artifact. Until that packaging slice
// lands, concatenate the import-clean interpreter sources into one compilation
// unit: compileMulti's per-source module initializers do not yet form one
// ordered standalone runtime initializer (#3525).

import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const INTERP_FILES = ["types.ts", "opcodes.ts", "encoder.ts", "runtime-ops.ts", "emitter.ts", "loop.ts"] as const;

function stripModuleSyntax(source: string): string {
  return source
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/^export \{[^;]+;\n/gm, "")
    .replace(/\bexport (?=(?:type|interface|class|const|function)\b)/g, "");
}

function e2BundleSource(): string {
  const interpreter = INTERP_FILES.map((name) => stripModuleSyntax(readFileSync(resolve("src/interp", name), "utf8")));

  return [
    ...interpreter,
    `
      function makeAst(): any {
        // Open objects match the compiled-Acorn $Object carrier consumed by
        // dynamic ESTree reads. Fixed-shape anonymous structs are a different
        // standalone representation once passed through any.
        const left: any = {};
        left.type = "Literal";
        left.value = 1;
        const right: any = {};
        right.type = "Literal";
        right.value = 2;
        const binary: any = {};
        binary.type = "BinaryExpression";
        binary.operator = "+";
        binary.left = left;
        binary.right = right;
        const statement: any = {};
        statement.type = "ExpressionStatement";
        statement.expression = binary;
        const body: any[] = [statement];
        const ast: any = {};
        ast.type = "Program";
        ast.sourceType = "script";
        ast.body = body;
        return ast;
      }

      export function test(): number {
        const globalObject: any = {};
        const env = new EnvRec(ENV_GLOBAL, null, null, null, globalObject);
        return interpEnter(emitProgram(makeAst()), env, globalObject, []) as number;
      }
    `,
  ].join("\n");
}

describe("#2928 E2 — self-compiled standalone interpreter canary", () => {
  it("emits bytecode and evaluates an ESTree 1 + 2 program entirely inside Wasm", async () => {
    const result = await compile(e2BundleSource(), {
      fileName: "issue-2928-e2-bundle.ts",
      skipSemanticDiagnostics: true,
      target: "standalone",
    });

    expect(
      result.success,
      result.errors
        .map((error) => `${error.file ? `${relative(process.cwd(), error.file)}:` : ""}${error.message}`)
        .join("\n"),
    ).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);

    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.test as () => number)()).toBe(3);
  }, 120_000);
});
