// react upstream-suite dogfood harness — React's OWN unit tests, run against
// React compiled to WebAssembly.
//
// Loop:
//   1. ACQUIRE  — pinned react npm tarball (published bytes, sha-verified) plus
//                 the matching upstream source tag at its immutable commit.
//                 See setup-react.mjs / setup-react-upstream-suite.mjs.
//   2. EXTRACT  — lift every `it()` out of React's real test files, verbatim,
//                 with its describe scope and beforeEach prelude. Tests needing
//                 ReactDOM / act / jest / a document are rejected BY REASON, not
//                 quietly dropped. See react-upstream-extract.mjs.
//   3. COMPILE  — one module: the published CommonJS React implementation,
//                 unmodified, + the `expect` shim + one exported function per
//                 admitted test. A test that breaks compilation is quarantined
//                 and reported, never silently removed.
//   4. ORACLE   — run the SAME generated test sources natively against the SAME
//                 pinned React. A test that fails natively is harness-
//                 incompatible and is excluded from the compiler score, with the
//                 reason recorded. It is never counted as a compiler bug.
//   5. RUN+DIFF — run each admitted test inside Wasm and diff against native.
//   6. REPORT   — JSON surface report + human summary.
//
// Invoke:  pnpm run dogfood:react-upstream-suite
//          node tests/dogfood/react-upstream-suite.mjs --json

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { compile } from "../../src/index.ts";
import { wrapExports } from "../../src/runtime.ts";
import { setupReact } from "./setup-react.mjs";
import { setupReactUpstreamSuite } from "./setup-react-upstream-suite.mjs";
import { extractReactUpstreamTests } from "./react-upstream-extract.mjs";
import { REACT_EXPECT_SHIM, LAST_ERROR_EXPORT, buildTestFunction } from "./react-upstream-shim.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(HERE, "report", "react-upstream-suite.json");

// `var exports = {}` makes the published CommonJS implementation an internal
// module value. Every byte of the implementation after that one binding is
// unmodified; the appended code only observes React's public API.
function buildModuleSource(reactSource, tests) {
  return [
    "var exports = {};",
    reactSource,
    "var __REACT__ = exports;",
    REACT_EXPECT_SHIM,
    ...tests.map((test) => buildTestFunction(test)),
    LAST_ERROR_EXPORT,
  ].join("\n");
}

// The native oracle runs the identical generated sources — same shim, same
// prelude, same body — so any difference is attributable to the compiler.
function buildNativeRunners(tests) {
  const source = [
    REACT_EXPECT_SHIM,
    ...tests.map((test) => buildTestFunction(test, { exported: false })),
    `return { __lastError: function () { return __lastError; }, tests: { ${tests
      .map((test) => `${JSON.stringify(test.id)}: ${test.id}`)
      .join(", ")} } };`,
  ].join("\n");
  // eslint-disable-next-line no-new-func
  return new Function("__REACT__", source);
}

function runNative(tests, nativeReact) {
  try {
    const runners = buildNativeRunners(tests)(nativeReact);
    return tests.map((test) => {
      let value;
      let error = null;
      try {
        value = runners.tests[test.id]();
      } catch (thrown) {
        error = thrown instanceof Error ? thrown.message : String(thrown);
      }
      return { id: test.id, value, error, message: value === 1 ? "" : runners.__lastError() };
    });
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return tests.map((test) => ({ id: test.id, value: undefined, error: `oracle build failed: ${message}` }));
  }
}

// A compile diagnostic points at a byte offset in the generated module. Map it
// back to the test that owns it so a single bad test can be quarantined instead
// of poisoning the whole run.
function quarantineFromErrors(moduleSource, tests, errors) {
  const offenders = new Set();
  for (const error of errors) {
    const marker = error.file ? null : null;
    void marker;
    const position = typeof error.start === "number" ? error.start : null;
    const line = typeof error.line === "number" ? error.line : null;
    let index = position;
    if (index === null && line !== null) {
      const lines = moduleSource.split("\n");
      index = lines.slice(0, line).join("\n").length;
    }
    if (index === null) continue;
    // Which test function contains this offset?
    for (const test of tests) {
      const start = moduleSource.indexOf(`export function ${test.id}(`);
      if (start === -1) continue;
      const end = moduleSource.indexOf("\nexport function ", start + 1);
      if (index >= start && (end === -1 || index < end)) {
        offenders.add(test.id);
        break;
      }
    }
  }
  return offenders;
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);

  // --- 1. ACQUIRE ----------------------------------------------------------
  const { root: packageRoot, version, pin } = setupReact();
  const { root: suiteRoot, pin: suitePin } = setupReactUpstreamSuite();
  const productionModulePath = join(packageRoot, "package", "cjs", "react.production.js");
  const reactSource = readFileSync(productionModulePath, "utf-8");

  const report = {
    generatedAt: new Date().toISOString(),
    react: { version, source: pin.tarball, entryModule: "package/cjs/react.production.js" },
    upstreamSuite: {
      repo: suitePin.repo,
      tag: suitePin.tag,
      commit: suitePin.commit,
      testFiles: suitePin.testFiles,
    },
    extraction: null,
    compile: null,
    validation: null,
    results: null,
    summary: {},
  };

  // --- 2. EXTRACT ----------------------------------------------------------
  const extracted = extractReactUpstreamTests({ root: suiteRoot, testFiles: suitePin.testFiles });
  report.extraction = {
    upstreamTestsSeen: extracted.tests.length + extracted.rejected.length,
    admitted: extracted.tests.length,
    rejected: extracted.rejected.length,
    rejectionCounts: extracted.rejectionCounts,
    rejectedTests: extracted.rejected,
  };
  log(
    `[dogfood] react@${version} upstream @ ${suitePin.tag}: ` +
      `${extracted.tests.length} of ${extracted.tests.length + extracted.rejected.length} upstream tests admitted`,
  );

  // --- 3. COMPILE (with quarantine) ----------------------------------------
  let admitted = extracted.tests;
  const quarantined = [];
  let result = null;
  let moduleSource = "";
  let compileMs = 0;

  for (let attempt = 0; attempt < 4; attempt++) {
    moduleSource = buildModuleSource(reactSource, admitted);
    const started = performance.now();
    try {
      result = await compile(moduleSource, { fileName: "react.production.js", skipSemanticDiagnostics: true });
    } catch (thrown) {
      result = { success: false, errors: [{ message: thrown instanceof Error ? thrown.message : String(thrown) }] };
    }
    compileMs = Math.round(performance.now() - started);
    if (result.success && result.binary?.length) break;

    const offenders = quarantineFromErrors(moduleSource, admitted, result.errors ?? []);
    if (offenders.size === 0) break;
    for (const test of admitted) {
      if (offenders.has(test.id)) quarantined.push({ ...test, reason: "compile-rejected" });
    }
    admitted = admitted.filter((test) => !offenders.has(test.id));
    log(`[dogfood] quarantined ${offenders.size} test(s) that broke compilation; retrying`);
  }

  report.compile = {
    success: result?.success ?? false,
    durationMs: compileMs,
    binaryBytes: result?.binary?.length ?? 0,
    errorCount: result?.errors?.length ?? 0,
    firstError: result?.errors?.[0]?.message ?? null,
    quarantined: quarantined.map((test) => ({ id: test.id, fullName: test.fullName, reason: test.reason })),
  };

  // --- 4. VALIDATE + INSTANTIATE -------------------------------------------
  let validates = false;
  let firstError = result?.errors?.[0]?.message ?? "no binary emitted";
  if (result?.success && result.binary?.length) {
    try {
      await WebAssembly.compile(result.binary);
      validates = true;
      firstError = null;
    } catch (error) {
      firstError = error instanceof Error ? error.message : String(error);
    }
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
      imports.__setInstance?.(instance);
      compiled = wrapExports(instance.exports, { signatures: result.exportSignatures });
    } catch (error) {
      firstError = `instantiate failed: ${error instanceof Error ? error.message : String(error)}`;
      report.validation.firstError = firstError;
    }
  }

  // --- 5. ORACLE + RUN + DIFF ----------------------------------------------
  const nativeResults = new Map(runNative(admitted, nativeReact).map((entry) => [entry.id, entry]));

  const readCompiledError = () => {
    try {
      return compiled?.__react_last_error?.() ?? "";
    } catch {
      return "";
    }
  };

  const tests = admitted.map((test) => {
    const native = nativeResults.get(test.id) ?? {};
    const entry = {
      id: test.id,
      file: test.file,
      fullName: test.fullName,
      nativePassed: native.value === 1,
      nativeMessage: native.error ?? native.message ?? "",
    };

    if (!entry.nativePassed) {
      // The harness could not reproduce this upstream test natively (a prelude
      // this shim cannot supply, a matcher nuance, a jsdom assumption). It is
      // NOT evidence about the compiler, so it is excluded from the score and
      // reported under its own bucket.
      entry.status = "harness-incompatible";
      return entry;
    }
    if (!compiled) {
      entry.status = "skipped";
      entry.skippedReason = firstError ?? "binary did not instantiate";
      return entry;
    }
    let value;
    try {
      value = compiled[test.id]();
    } catch (error) {
      entry.status = "trapped";
      entry.compiledMessage = error instanceof Error ? error.message : String(error);
      return entry;
    }
    entry.compiledPassed = value === 1;
    entry.status = value === 1 ? "pass" : "fail";
    if (value !== 1) entry.compiledMessage = readCompiledError();
    return entry;
  });

  const scored = tests.filter((test) => test.status !== "harness-incompatible");
  const passed = tests.filter((test) => test.status === "pass").length;
  const failed = scored.length - passed;

  const failuresByFile = {};
  for (const test of tests) {
    if (test.status === "fail" || test.status === "trapped") {
      failuresByFile[test.file] = (failuresByFile[test.file] ?? 0) + 1;
    }
  }

  report.results = {
    scored: scored.length,
    passed,
    failed,
    harnessIncompatible: tests.length - scored.length,
    failuresByFile,
    tests,
  };
  report.summary = {
    headline: `${passed}/${scored.length} upstream React tests pass against compiled Wasm`,
    passRatePct: scored.length ? Number(((passed / scored.length) * 100).toFixed(2)) : 0,
    upstreamTestsSeen: report.extraction.upstreamTestsSeen,
    admitted: report.extraction.admitted,
    scored: scored.length,
    passed,
    failed,
    harnessIncompatible: report.results.harnessIncompatible,
    quarantined: quarantined.length,
    compileMs,
    binaryBytes: report.compile.binaryBytes,
    binaryValidates: validates,
  };

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  log(`[dogfood] ${report.summary.headline}`);
  log(`[dogfood] full report → ${REPORT_PATH}`);
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
