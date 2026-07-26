// #2928 E6 — real Acorn + interpreter provider packaging probe.
//
// Acorn and the import-clean interpreter sources are compiled as ONE source
// unit. This gives the provider exactly one ordered initializer without relying
// on compileMulti's current per-source initializer ownership (#3525), and keeps
// ESTree objects inside the provider rather than exposing them as a link ABI.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { compile } from "../../src/index.ts";
import { setupAcorn } from "../dogfood/setup-acorn.mjs";

const INTERP_FILES = [
  "types.ts",
  "opcodes.ts",
  "encoder.ts",
  "runtime-ops.ts",
  "emitter.ts",
  "loop.ts",
  "dynamic-function.ts",
];

function stripModuleSyntax(source) {
  return source
    .replace(/^import[\s\S]*?;\n/gm, "")
    .replace(/^export \{[^;]+;\n/gm, "")
    .replace(/\bexport (?=(?:type|interface|class|const|function)\b)/g, "");
}

function providerSource() {
  const { entryModulePath } = setupAcorn();
  const acorn = stripModuleSyntax(readFileSync(entryModulePath, "utf8"));
  const interpreter = INTERP_FILES.map((name) => stripModuleSyntax(readFileSync(resolve("src/interp", name), "utf8")));

  return [
    acorn,
    ...interpreter,
    `
      export function __runtime_new_function(
        paramString: any,
        bodyString: any,
        globalObject: any
      ): any {
        return createDynamicFunction(
          parse,
          String(paramString),
          String(bodyString),
          globalObject
        );
      }

      export function __runtime_indirect_eval(
        source: any,
        globalObject: any
      ): any {
        return executeIndirectEval(parse, source, globalObject);
      }

      export function __runtime_eval_canary(): number {
        return executeIndirectEval(parse, "1 + 2", {}) as number;
      }

      export function __runtime_function_canary(): number {
        const fn = createDynamicFunction(
          parse,
          "a,b",
          "return a + b",
          {}
        );
        return fn(1, 2) as number;
      }
    `,
  ].join("\n");
}

function describeDiagnostic(diagnostic) {
  return diagnostic?.messageText ?? diagnostic?.message ?? String(diagnostic);
}

async function main() {
  const provider = await compile(providerSource(), {
    experimentalIR: false,
    fileName: "runtime-eval-acorn-provider.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  const user = await compile(
    `
      function dynamic(value: string): string {
        return value;
      }

      export function linkedEval(): number {
        globalThis.answer = 40;
        return (0, eval)(dynamic("answer + 2")) as number;
      }
    `,
    {
      fileName: "runtime-eval-acorn-user.ts",
      skipSemanticDiagnostics: true,
      target: "standalone",
    },
  );
  const report = {
    success: provider.success,
    errors: provider.errors.map(describeDiagnostic),
    bytes: provider.binary.length,
    imports: [],
    exports: [],
    userSuccess: user.success,
    userErrors: user.errors.map(describeDiagnostic),
    userImports: [],
    functionCanaryEnabled: process.env.JS2WASM_RUNTIME_FUNCTION_CANARY === "1",
    values: {},
    executionErrors: {},
  };

  if (provider.binary.length > 0 && user.binary.length > 0) {
    const module = new WebAssembly.Module(provider.binary);
    const userModule = new WebAssembly.Module(user.binary);
    report.imports = WebAssembly.Module.imports(module);
    report.exports = WebAssembly.Module.exports(module).filter((entry) => entry.name.startsWith("__runtime_"));
    report.userImports = WebAssembly.Module.imports(userModule);
    if (provider.success && user.success && report.imports.length === 0) {
      try {
        const instance = new WebAssembly.Instance(module, {});
        const userInstance = new WebAssembly.Instance(userModule, {
          "js2wasm:runtime-eval": {
            __runtime_indirect_eval: instance.exports.__runtime_indirect_eval,
          },
        });
        const canaries = [
          ["eval", instance.exports.__runtime_eval_canary],
          ["linkedEval", userInstance.exports.linkedEval],
        ];
        if (report.functionCanaryEnabled) {
          canaries.push(["function", instance.exports.__runtime_function_canary]);
        }
        for (const [name, fn] of canaries) {
          try {
            report.values[name] = fn();
          } catch (error) {
            report.executionErrors[name] = error?.stack ?? error?.message ?? String(error);
          }
        }
      } catch (error) {
        report.executionErrors.instantiate = error?.stack ?? error?.message ?? String(error);
      }
    }
  }

  process.stdout.write(`${JSON.stringify(report)}\n`);
}

main().catch((error) => {
  process.stdout.write(
    `${JSON.stringify({
      success: false,
      errors: [error?.stack ?? error?.message ?? String(error)],
      bytes: 0,
      imports: [],
      exports: [],
      userSuccess: false,
      userErrors: [],
      userImports: [],
      functionCanaryEnabled: process.env.JS2WASM_RUNTIME_FUNCTION_CANARY === "1",
      values: {},
      executionErrors: {},
    })}\n`,
  );
});
