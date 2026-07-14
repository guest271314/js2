#!/usr/bin/env node
// #3259 — god-file bloat profiler.
//
// jscpd/knip are blind to the god-files (jscpd's tokenizer silently drops
// files >~1k lines; see plan/log/3259-bloat-quickwins-report.md). This profiler
// is file-size-agnostic: it walks each target file with the TS compiler API,
// ranks top-level functions by LOC, and measures **emission density** — the
// count of `op:` Instr-literals per function — which classifies the bloat SHAPE:
//
//   - HIGH ops/LOC  (ensure*Runtime / ensure*Helpers) = hand-emitted Wasm
//     runtime written as JS  → SELF-HOST lever (#3256 strings / #3257 arrays /
//     #3258 objects) deletes it wholesale.
//   - HUGE LOC, LOW ops/LOC  (compileCallExpression) = accumulated special-case
//     dispatch hairball  → IR-migration (#2855) + legacy-handler deletion
//     (#3090), not self-host.
//   - ~ZERO ops = legitimate orchestration (generateModule, registerWasiImports)
//     — not bloat, leave alone.
//
// Complements `audit-legacy-reachability.mjs` (which classifies functions as
// legacy-only vs shared vs dead) — run that for the #3090 deletion prize; run
// THIS for the self-host prize + a regression gate on function girth.
//
// Modes:
//   node scripts/profile-godfiles.mjs            # ranked human report
//   node scripts/profile-godfiles.mjs --json     # machine-readable
//   node scripts/profile-godfiles.mjs --check     # gate vs baseline (CI)
//   node scripts/profile-godfiles.mjs --update    # refresh the baseline
//
// The --check gate fails when a NEW mega-function appears or a tracked one grows
// past its baseline LOC by the drift margin — a ratchet against re-bloating the
// god-files while the self-host / IR migrations shrink them.

import ts from "typescript";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_PATH = path.join(ROOT, "scripts", "godfile-profile-baseline.json");

// The files worth watching. A file earns a slot by being a known bloat lever;
// keep this list in sync with plan/self-hosting-scale-up.md.
const TARGETS = [
  "src/codegen/expressions/calls.ts",
  "src/codegen/index.ts",
  "src/codegen/object-runtime.ts",
  "src/codegen/array-methods.ts",
  "src/codegen/native-strings.ts",
];

// A function must be at least this many LOC to be tracked by the gate — smaller
// functions are noise and churn the baseline.
const TRACK_MIN_LOC = 150;
// Allowed growth (LOC) of a tracked function before --check fails. Absorbs
// ordinary edits; a genuine new hairball blows past it.
const DRIFT_MARGIN = 40;

function profileFile(relFile) {
  let src;
  try {
    src = readFileSync(path.join(ROOT, relFile), "utf8");
  } catch {
    return null;
  }
  const sf = ts.createSourceFile(relFile, src, ts.ScriptTarget.Latest, true);
  const fns = [];
  const visit = (n) => {
    let name = null;
    if (ts.isFunctionDeclaration(n) && n.name) name = n.name.text;
    else if (ts.isMethodDeclaration(n) && n.name) name = n.name.getText(sf);
    else if (ts.isVariableStatement(n)) {
      const d = n.declarationList.declarations[0];
      if (d && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)))
        name = d.name.getText(sf);
    }
    if (name) {
      const start = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
      const end = sf.getLineAndCharacterOfPosition(n.getEnd()).line;
      const body = src.slice(n.getStart(sf), n.getEnd());
      const ops = (body.match(/\bop:\s*["'`]/g) || []).length;
      const loc = end - start + 1;
      // shape classifier: density of Instr emission per 100 LOC
      const density = loc > 0 ? ops / loc : 0;
      let shape;
      if (ops < 5) shape = "orchestration";
      else if (density >= 0.15)
        shape = "hand-emitted-runtime"; // self-host lever
      else shape = "dispatch-hairball"; // IR-migration / legacy-delete lever
      fns.push({ name, loc, ops, density: +density.toFixed(3), shape });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  const total = src.split("\n").length;
  const totalOps = fns.reduce((a, x) => a + x.ops, 0);
  fns.sort((a, b) => b.loc - a.loc);
  return { file: relFile, total, totalOps, fns };
}

const profiles = TARGETS.map(profileFile).filter(Boolean);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(profiles, null, 2));
  process.exit(0);
}

// Flatten tracked (>= TRACK_MIN_LOC) functions to {id: loc}.
function trackedMap() {
  const m = {};
  for (const p of profiles) for (const fn of p.fns) if (fn.loc >= TRACK_MIN_LOC) m[`${p.file}#${fn.name}`] = fn.loc;
  return m;
}

if (process.argv.includes("--update")) {
  writeFileSync(BASELINE_PATH, JSON.stringify(trackedMap(), null, 1) + "\n");
  console.log(`godfile-profile baseline updated: ${Object.keys(trackedMap()).length} tracked functions.`);
  process.exit(0);
}

if (process.argv.includes("--check")) {
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    console.error(`godfile-profile gate: missing ${path.relative(ROOT, BASELINE_PATH)} — seed it with --update.`);
    process.exit(1);
  }
  const cur = trackedMap();
  const problems = [];
  for (const [id, loc] of Object.entries(cur)) {
    if (!(id in baseline)) problems.push(`NEW mega-function (${loc} LOC): ${id}`);
    else if (loc > baseline[id] + DRIFT_MARGIN)
      problems.push(`GREW ${baseline[id]}→${loc} LOC (+${loc - baseline[id]}, margin ${DRIFT_MARGIN}): ${id}`);
  }
  const shrunk = Object.keys(baseline).filter((id) => id in cur && cur[id] < baseline[id] - DRIFT_MARGIN);
  if (shrunk.length)
    console.log(
      `godfile-profile gate: ${shrunk.length} tracked function(s) shrank — refresh with --update when convenient.`,
    );
  if (problems.length) {
    console.error(`godfile-profile gate: ${problems.length} regression(s):`);
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      "Shrink the function (self-host / IR-migrate / split), or if intentional refresh: node scripts/profile-godfiles.mjs --update",
    );
    process.exit(1);
  }
  console.log(`godfile-profile gate: OK (${Object.keys(cur).length} tracked functions, none new/grown).`);
  process.exit(0);
}

// Human report.
const shapeTotals = { "hand-emitted-runtime": 0, "dispatch-hairball": 0, orchestration: 0 };
for (const p of profiles) {
  console.log(`\n=== ${p.file}  (${p.total} LOC, ${p.totalOps} op:-emissions across ${p.fns.length} fns) ===`);
  for (const fn of p.fns.slice(0, 8)) {
    console.log(
      `  ${String(fn.loc).padStart(5)} LOC  ${String(fn.ops).padStart(4)} ops  d=${fn.density.toFixed(2).padStart(4)}  ${fn.shape.padEnd(20)}  ${fn.name}`,
    );
  }
  for (const fn of p.fns) shapeTotals[fn.shape] += fn.loc;
}
console.log("\n=== bloat by shape → lever ===");
console.log(
  `  hand-emitted-runtime  ${String(shapeTotals["hand-emitted-runtime"]).padStart(6)} LOC  → self-host  #3256/#3257/#3258`,
);
console.log(
  `  dispatch-hairball     ${String(shapeTotals["dispatch-hairball"]).padStart(6)} LOC  → IR migration #2855 / legacy-delete #3090`,
);
console.log(`  orchestration         ${String(shapeTotals.orchestration).padStart(6)} LOC  → leave (not bloat)`);
