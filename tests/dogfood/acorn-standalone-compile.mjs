// Acorn standalone compile probe (#1712 / #2847).
//
// Kept in a child process because compiling the 230 KB parser graph needs a
// substantially larger heap than Vitest's normal worker. The source is the
// same committed, integrity-checked acorn@8.16.0 tarball used by the host
// differential corpus.

import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

import { compile } from "../../src/index.ts";
import { setupAcorn } from "./setup-acorn.mjs";

function describeDiagnostic(diagnostic) {
  if (diagnostic == null) return String(diagnostic);
  if (typeof diagnostic === "string") return diagnostic;
  const message = diagnostic.messageText ?? diagnostic.message ?? diagnostic;
  if (typeof message === "string") return message;
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

export async function compileStandaloneAcorn() {
  const { entryModulePath, version } = setupAcorn();
  const packageSource = readFileSync(entryModulePath, "utf-8");

  // Keep the public `parse(nativeString, options) -> AST` export untouched and
  // add a no-argument in-module canary. A JS host cannot manufacture the
  // parser's private native-string carrier directly, so this wrapper executes
  // the package without adding a host marshalling bridge.
  const source = `${packageSource}
export function __acorn_runtime_canary() {
  const ast = parse("1 + 2", { ecmaVersion: 2025, sourceType: "script" });
  const statement = ast.body[0];
  const expression = statement.expression;
  return ast.type === "Program" &&
    ast.body.length === 1 &&
    statement.type === "ExpressionStatement" &&
    expression.type === "BinaryExpression" &&
    expression.operator === "+" &&
    expression.left.value === 1 &&
    expression.right.value === 2 ? 2 : -1;
}
`;

  const started = performance.now();
  const result = await compile(source, {
    fileName: "acorn.mjs",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  const compileMs = Math.round(performance.now() - started);
  const errors = (result.errors ?? []).map(describeDiagnostic);

  if (!result.binary?.length) {
    return {
      acornVersion: version,
      success: false,
      compileMs,
      binaryBytes: 0,
      errors,
      runtimeCanary: null,
      functionImports: [],
      exports: [],
    };
  }

  const module = await WebAssembly.compile(result.binary);
  const imports = WebAssembly.Module.imports(module);
  let runtimeCanary = null;
  if (result.success && imports.length === 0) {
    const { exports } = await WebAssembly.instantiate(module, {});
    runtimeCanary = exports.__acorn_runtime_canary();
  }

  return {
    acornVersion: version,
    success: result.success,
    compileMs,
    binaryBytes: result.binary.length,
    errors,
    runtimeCanary,
    functionImports: imports
      .filter((entry) => entry.kind === "function")
      .map((entry) => `${entry.module}::${entry.name}`),
    exports: WebAssembly.Module.exports(module)
      .filter((entry) => entry.kind === "function")
      .map((entry) => entry.name),
  };
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  compileStandaloneAcorn()
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      process.stdout.write(
        `${JSON.stringify(
          {
            success: false,
            errors: [error?.stack ?? error?.message ?? String(error)],
            functionImports: [],
            exports: [],
          },
          null,
          2,
        )}\n`,
      );
    });
}
