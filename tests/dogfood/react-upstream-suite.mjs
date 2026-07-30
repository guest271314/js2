import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { compile } from "../../src/index.ts";
import { wrapExports } from "../../src/runtime.ts";
import { setupReact } from "./setup-react.mjs";
import { setupReactUpstreamSuite } from "./setup-react-upstream-suite.mjs";
import { REACT_UPSTREAM_VECTORS, buildReactUpstreamDriver } from "./react-upstream-vectors.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(HERE, "report", "react-upstream-suite.json");

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const { root: packageRoot, version, pin } = setupReact();
  const { pin: suitePin, testPaths } = setupReactUpstreamSuite();
  const productionModulePath = join(packageRoot, "package", "cjs", "react.production.js");
  const source = readFileSync(productionModulePath, "utf-8");
  const report = {
    generatedAt: new Date().toISOString(),
    react: { version, source: pin.tarball, entryModule: "package/cjs/react.production.js" },
    upstreamSuite: { repo: suitePin.repo, tag: suitePin.tag, commit: suitePin.commit, sourceFiles: suitePin.testFiles },
    compile: null,
    validation: null,
    results: null,
    summary: {},
  };

  // `var exports = {}` makes the published CommonJS implementation an
  // internal module value. The implementation bytes after this one binding
  // are unmodified; the exported wrappers only observe public React APIs.
  const driverSource = `var exports = {};\n${source}\n${buildReactUpstreamDriver()}`;
  const started = performance.now();
  const result = await compile(driverSource, { fileName: "react.production.js", skipSemanticDiagnostics: true });
  const compileMs = Math.round(performance.now() - started);
  report.compile = {
    success: result.success,
    durationMs: compileMs,
    binaryBytes: result.binary?.length ?? 0,
    errorCount: result.errors.length,
  };

  let validates = false;
  let firstError = null;
  if (result.success && result.binary?.length) {
    try {
      await WebAssembly.compile(result.binary);
      validates = true;
    } catch (error) {
      firstError = error instanceof Error ? error.message : String(error);
    }
  } else {
    firstError = result.errors[0]?.message ?? "no binary emitted";
  }
  report.validation = { validates, firstError };

  const require = createRequire(import.meta.url);
  const nativeReact = require(productionModulePath);
  let compiled = null;
  if (validates) {
    try {
      const imports = result.importObject ?? {};
      const { instance } = await WebAssembly.instantiate(result.binary, imports);
      imports.__setExports?.(instance.exports);
      compiled = wrapExports(instance.exports, { signatures: result.exportSignatures });
    } catch (error) {
      firstError = `instantiate failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const vectors = REACT_UPSTREAM_VECTORS.map((vector) => {
    const entry = { name: vector.name, sourceFile: vector.sourceFile, sourceTest: vector.sourceTest };
    try {
      entry.nativeValue = new Function("REACT", vector.body)(nativeReact);
    } catch (error) {
      entry.nativeError = error instanceof Error ? error.message : String(error);
    }
    if (!compiled) {
      entry.status = "skipped";
      entry.skippedReason = firstError ?? "binary did not instantiate";
      return entry;
    }
    try {
      entry.compiledValue = compiled[vector.name]();
    } catch (error) {
      entry.compiledError = error instanceof Error ? error.message : String(error);
    }
    entry.status = entry.nativeValue === 1 && entry.compiledValue === 1 ? "equal" : "divergent";
    return entry;
  });
  const passed = vectors.filter((vector) => vector.status === "equal").length;
  report.results = { total: vectors.length, passed, failed: vectors.length - passed, vectors };
  report.summary = {
    headline: `${passed}/${vectors.length} source-attributed public API vectors passed`,
    passRatePct: Number(((passed / vectors.length) * 100).toFixed(2)),
    compileMs,
    sourceFilesVerified: testPaths.length,
  };
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  log(`[dogfood] react@${version} upstream vectors @ ${suitePin.tag}: ${report.summary.headline}`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const jsonOnly = process.argv.includes("--json");
  runHarness({ quiet: jsonOnly })
    .then((report) => jsonOnly && process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch((error) => {
      if (jsonOnly)
        process.stdout.write(`${JSON.stringify({ fatal: error instanceof Error ? error.message : String(error) })}\n`);
      else console.error(error);
      process.exitCode = 1;
    });
}
