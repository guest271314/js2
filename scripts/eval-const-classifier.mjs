#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2923 (roadmap §5.4) — dry-run classifier sizing the Tier-0 constant-string
// `eval` compile-away win. Walks test262 (or a `--dir`), finds every `eval(...)`
// / `(0,eval)(...)` call-SITE, and classifies its first argument as:
//
//   const   — a compile-time-constant string (string/template literal, or a `+`
//             chain of them) → liftable by tryStaticEvalInline (#1163/#2923),
//   dynamic — anything else (a variable, concatenation with a non-constant, a
//             function result, …) → needs the Tier-2 interpreter (#2928),
//   noarg   — `eval()` with no argument.
//
// Reuses the SAME `resolveConstantString` oracle the inliner uses, so the count
// matches what actually lifts. Pure read-only AST scan — emits a logged summary.
//
// Runs via tsx (it imports the real `resolveConstantString` oracle from src).
// Usage:
//   npx tsx scripts/eval-const-classifier.mjs [--dir <path>] [--json] [--limit N]
//
// Logged artifact (test262/test, 2026-07-02): 1460 files with an eval site,
// 2611 call-sites — 2394 (91.7%) constant-string (Tier-0 liftable by #1163/#2923),
// 210 dynamic (needs the Tier-2 interpreter #2928), 7 no-arg.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { ts } from "../src/ts-api.ts";
import { resolveConstantString } from "../src/codegen/expressions/eval-inline.ts";

const args = process.argv.slice(2);
const getOpt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};
const asJson = args.includes("--json");
const rootDir = getOpt("--dir", "test262/test");
const limit = Number(getOpt("--limit", "0")) || Infinity;

/** Fast prefilter: only .js files that mention `eval(` (grep is ~100x faster than parsing all). */
function candidateFiles(dir) {
  try {
    const out = execSync(`grep -rlE 'eval[[:space:]]*\\(' ${dir} --include='*.js' 2>/dev/null || true`, {
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    });
    return out.split("\n").filter(Boolean);
  } catch {
    // Fallback: recursive walk.
    const acc = [];
    const walk = (d) => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (p.endsWith(".js") && readFileSync(p, "utf8").includes("eval(")) acc.push(p);
      }
    };
    walk(dir);
    return acc;
  }
}

/** Is this call an `eval(...)` or `(0, eval)(...)` site? (syntactic — no checker) */
function isEvalCall(node) {
  if (!ts.isCallExpression(node)) return false;
  let callee = node.expression;
  while (ts.isParenthesizedExpression(callee)) callee = callee.expression;
  if (ts.isIdentifier(callee) && callee.text === "eval") return true;
  // (0, eval)(...) indirect form
  if (ts.isBinaryExpression(callee) && callee.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    let r = callee.right;
    while (ts.isParenthesizedExpression(r)) r = r.expression;
    return ts.isIdentifier(r) && r.text === "eval";
  }
  return false;
}

const counts = { const: 0, dynamic: 0, noarg: 0 };
let filesWithEval = 0;
let sites = 0;

const files = candidateFiles(rootDir);
let scanned = 0;
for (const file of files) {
  if (scanned >= limit) break;
  scanned++;
  let src;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let fileHadEval = false;
  const visit = (n) => {
    if (isEvalCall(n)) {
      fileHadEval = true;
      sites++;
      if (n.arguments.length === 0) counts.noarg++;
      else if (resolveConstantString(n.arguments[0]) !== null) counts.const++;
      else counts.dynamic++;
    }
    n.forEachChild(visit);
  };
  sf.forEachChild(visit);
  if (fileHadEval) filesWithEval++;
}

const result = {
  root: rootDir,
  filesScanned: scanned,
  filesWithEvalSite: filesWithEval,
  evalSites: sites,
  constantString: counts.const,
  dynamic: counts.dynamic,
  noArg: counts.noarg,
  constantSharePct: sites ? Math.round((counts.const / sites) * 1000) / 10 : 0,
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`[eval-const-classifier] ${rootDir}`);
  console.log(`  files with an eval site : ${filesWithEval}`);
  console.log(`  eval call-sites total   : ${sites}`);
  console.log(`  ├─ constant-string (liftable, Tier-0) : ${counts.const}  (${result.constantSharePct}%)`);
  console.log(`  ├─ dynamic (needs interpreter #2928)  : ${counts.dynamic}`);
  console.log(`  └─ no-arg                             : ${counts.noarg}`);
}
