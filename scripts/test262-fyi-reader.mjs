// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Lightweight access to test262.fyi's source assembler. Keep compiler/runtime
// imports out of this module so parity tests can compare source records without
// loading a second bundled compiler into the Vitest process.
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FYI_ROOT = join(ROOT, "test262-fyi", "data");
const TEST262_ROOT = join(ROOT, "test262");
const RUNTIME_PATH = join(ROOT, "scripts", "test262-fyi-runtime.js");

function normalizeTestPath(path) {
  const normalized = path
    .replaceAll("\\", "/")
    .replace(/^\/+/, "")
    .replace(/^test\//, "");
  if (!normalized || normalized.split("/").includes("..")) {
    throw new Error(`invalid test262 path: ${path}`);
  }
  return normalized;
}

// Keep quoted module specifiers intact while hiding comments and templates
// from the small static-import recognizer below. Test262 frontmatter often
// contains import examples which must not become real graph edges.
function maskCommentsAndTemplates(source) {
  const masked = source.split("");
  let quote;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const next = source[index + 1];

    if (quote) {
      if (char === "\\") {
        index++;
        continue;
      }
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "`" || (char === "/" && (next === "/" || next === "*"))) {
      const lineComment = char === "/" && next === "/";
      const blockComment = char === "/" && next === "*";
      const closing = blockComment ? "*/" : char;
      masked[index] = " ";
      if (blockComment || lineComment) masked[++index] = " ";
      for (index++; index < source.length; index++) {
        const current = source[index];
        if (current !== "\n" && current !== "\r") masked[index] = " ";
        if (lineComment && (current === "\n" || current === "\r")) break;
        if (!lineComment && current === "\\") {
          if (index + 1 < source.length) masked[++index] = " ";
          continue;
        }
        if (!lineComment && source.startsWith(closing, index)) {
          if (closing.length === 2) masked[++index] = " ";
          break;
        }
      }
    }
  }
  return masked.join("");
}

/**
 * Return relative static import/export specifiers ending in `_FIXTURE.js`.
 * Dynamic `import()` is intentionally excluded: it is a runtime host-loader
 * concern, not part of the statically linked module graph handled here.
 */
export function staticFixtureSpecifiers(source) {
  const masked = maskCommentsAndTemplates(source);
  const declaration =
    /(?:^|[;\r\n])\s*(?:import\s+(?!\s*[.(])(?:(?:(?!;).)*?\bfrom\s*)?|export\s+(?:(?!;).)*?\bfrom\s*)(['"])([^'"]*_FIXTURE\.js)\1/gms;
  const specifiers = [];
  let match;
  while ((match = declaration.exec(masked)) !== null) specifiers.push(match[2]);
  return [...new Set(specifiers)];
}

/**
 * Read the complete reachable static Test262 fixture graph for one entry.
 * Keys remain rooted at the pinned Test262 `test/` tree, so the worker can
 * compile the entry under its original path without rewriting specifiers.
 */
export function discoverFixtureGraph(testPath, entrySource) {
  const normalizedEntry = normalizeTestPath(testPath);
  const testRoot = resolve(TEST262_ROOT, "test");
  const fixtureFiles = {};
  const visited = new Set();

  const visit = (importerPath, source) => {
    for (const specifier of staticFixtureSpecifiers(source)) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        throw new Error(`fixture specifier must be relative in ${importerPath}: ${specifier}`);
      }
      const absolute = resolve(testRoot, dirname(importerPath), specifier);
      if (absolute !== testRoot && !absolute.startsWith(`${testRoot}${sep}`)) {
        throw new Error(`fixture escapes pinned Test262 test root in ${importerPath}: ${specifier}`);
      }
      const fixturePath = relative(testRoot, absolute).replaceAll("\\", "/");
      if (!fixturePath.endsWith("_FIXTURE.js")) {
        throw new Error(`invalid Test262 fixture path in ${importerPath}: ${specifier}`);
      }
      if (visited.has(fixturePath)) continue;
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
        throw new Error(`missing Test262 fixture imported by ${importerPath}: ${specifier}`);
      }

      visited.add(fixturePath);
      const fixtureSource = fs.readFileSync(absolute, "utf8");
      fixtureFiles[`./${fixturePath}`] = fixtureSource;
      visit(fixturePath, fixtureSource);
    }
  };

  visit(normalizedEntry, entrySource);
  return {
    entryFile: `./${normalizedEntry}`,
    fixtureFiles,
  };
}

function attachFixtureGraphs(tests) {
  for (const test of tests) {
    const graph = discoverFixtureGraph(test.file, test.contents);
    if (Object.keys(graph.fixtureFiles).length > 0) Object.assign(test, graph);
  }
  return tests;
}

function requireOptionalInputs() {
  const reader = join(FYI_ROOT, "runner", "read.js");
  if (!fs.existsSync(reader)) {
    throw new Error(
      "test262-fyi/data is not initialized; run: git submodule update --init --checkout test262-fyi/data",
    );
  }
  if (!fs.existsSync(join(TEST262_ROOT, "harness", "assert.js"))) {
    throw new Error("test262 is not initialized; run: git submodule update --init test262");
  }
  return reader;
}

function readHarnessPreludes() {
  const harnessDir = join(TEST262_ROOT, "harness");
  const preludes = {};
  for (const entry of fs.readdirSync(harnessDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".js")) {
      preludes[entry.name] = fs.readFileSync(join(harnessDir, entry.name), "utf8");
      continue;
    }
    if (!entry.isDirectory()) continue;
    for (const child of fs.readdirSync(join(harnessDir, entry.name), { withFileTypes: true })) {
      if (child.isFile() && child.name.endsWith(".js")) {
        preludes[`${entry.name}/${child.name}`] = fs.readFileSync(join(harnessDir, entry.name, child.name), "utf8");
      }
    }
  }
  return preludes;
}

export async function loadOriginalHarnessTests(selectedPaths) {
  const reader = requireOptionalInputs();
  const { default: readTests } = await import(pathToFileURL(reader).href);
  const runtime = fs.readFileSync(RUNTIME_PATH, "utf8");
  if (!selectedPaths) return attachFixtureGraphs(await readTests(TEST262_ROOT, readHarnessPreludes(), runtime));

  // test262.fyi's reader eagerly retains every assembled source in the corpus.
  // Give parity tests a sparse mirror so small samples do not require hundreds
  // of megabytes merely to exercise the original reader implementation.
  const scratch = fs.mkdtempSync(join(tmpdir(), "js2wasm-test262-fyi-reader-"));
  try {
    for (const path of selectedPaths) {
      const normalized = normalizeTestPath(path);
      const destination = join(scratch, "test", normalized);
      fs.mkdirSync(dirname(destination), { recursive: true });
      fs.copyFileSync(join(TEST262_ROOT, "test", normalized), destination);
    }
    return attachFixtureGraphs(await readTests(scratch, readHarnessPreludes(), runtime));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function discoverTestPaths() {
  const testRoot = join(TEST262_ROOT, "test");
  const paths = [];
  const scan = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        scan(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.includes("_FIXTURE")) {
        paths.push(absolute.slice(testRoot.length + 1).replaceAll("\\", "/"));
      }
    }
  };
  scan(testRoot);
  return paths.sort((a, b) => a.localeCompare(b));
}
