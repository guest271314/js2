#!/usr/bin/env node
// (#1930) Oracle ratchet — fails CI when direct TS-checker usage under
// src/codegen/ GROWS. Mechanics mirror check:ir-fallbacks (#2855):
//   - baseline: scripts/oracle-ratchet-baseline.json
//     { files: { "<rel path>": { getTypeAtLocation: n, ctxChecker: n } },
//       preauthorized: [ { file, field, extra, reason } ] }
//   - growth beyond baseline+preauth fails with a per-file report;
//   - `--update` rewrites the baseline wholesale (intentional changes);
//   - `--update-on-decrease` banks lower counts only (post-merge job).
//
// Counted patterns (occurrences, not lines):
//   getTypeAtLocation:  /\bgetTypeAtLocation\s*\(/g
//   ctxChecker:         /\bctx\.checker\b/g
// Scope: src/codegen/**/*.ts. Symbol/binding resolution via a local
// `checker` param is intentionally NOT counted in v1 (name resolution is
// out of the oracle's scope — see issue #1930 D3 "explicitly OUT").
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChangeBase, changeSetAllowances } from "./lib/change-scope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCOPE = join(ROOT, "src", "codegen");
const BASELINE_PATH = join(ROOT, "scripts", "oracle-ratchet-baseline.json");

const update = process.argv.includes("--update");
const updateOnDecrease = process.argv.includes("--update-on-decrease");
const verbose = process.argv.includes("--verbose");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

function countIn(src, re) {
  const m = src.match(re);
  return m ? m.length : 0;
}

const current = {};
for (const file of walk(SCOPE)) {
  const src = readFileSync(file, "utf-8");
  const getTypeAtLocation = countIn(src, /\bgetTypeAtLocation\s*\(/g);
  const ctxChecker = countIn(src, /\bctx\.checker\b/g);
  if (getTypeAtLocation > 0 || ctxChecker > 0) {
    current[relative(ROOT, file)] = { getTypeAtLocation, ctxChecker };
  }
}

const totals = (obj) =>
  Object.values(obj).reduce(
    (a, c) => ({
      getTypeAtLocation: a.getTypeAtLocation + c.getTypeAtLocation,
      ctxChecker: a.ctxChecker + c.ctxChecker,
    }),
    { getTypeAtLocation: 0, ctxChecker: 0 },
  );

if (update) {
  writeFileSync(BASELINE_PATH, JSON.stringify({ files: current, preauthorized: [] }, null, 2) + "\n");
  const t = totals(current);
  console.log(
    `[oracle-ratchet] baseline updated: ${Object.keys(current).length} files, ` +
      `getTypeAtLocation=${t.getTypeAtLocation}, ctx.checker=${t.ctxChecker}`,
  );
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
} catch {
  console.error(`[oracle-ratchet] missing/invalid baseline at ${BASELINE_PATH} — run with --update to seed.`);
  process.exit(1);
}

const preauth = new Map();
for (const p of baseline.preauthorized ?? []) {
  preauth.set(`${p.file}::${p.field}`, (preauth.get(`${p.file}::${p.field}`) ?? 0) + (p.extra ?? 0));
}

const failures = [];
let decreased = false;
const merged = { ...baseline.files };
for (const [file, counts] of Object.entries(current)) {
  const base = baseline.files[file] ?? { getTypeAtLocation: 0, ctxChecker: 0 };
  for (const field of ["getTypeAtLocation", "ctxChecker"]) {
    const allowed = (base[field] ?? 0) + (preauth.get(`${file}::${field}`) ?? 0);
    if (counts[field] > allowed) {
      failures.push(`${file}: ${field} ${counts[field]} > baseline ${allowed}`);
    } else if (counts[field] < (base[field] ?? 0)) {
      decreased = true;
    }
  }
  merged[file] = counts;
}
// Files that disappeared entirely count as decreases.
for (const file of Object.keys(baseline.files)) {
  if (!current[file]) {
    decreased = true;
    delete merged[file];
  }
}

if (verbose) {
  const t = totals(current);
  console.log(`[oracle-ratchet] current totals: getTypeAtLocation=${t.getTypeAtLocation}, ctx.checker=${t.ctxChecker}`);
}

if (failures.length > 0) {
  // Intentional-growth hatch (#3131), same change-scoped frontmatter mechanism
  // as check:loc-budget / check:coercion-sites: a change-set waives growth for a
  // file by listing its repo-relative path under an `oracle-ratchet-allow:` key
  // in the YAML frontmatter of a plan/issues/*.md file THE CHANGE-SET ITSELF
  // adds or modifies. This keeps god-file splits (which merely RELOCATE existing
  // checker call-sites verbatim — total usage conserved) from touching the
  // whole-tree baseline JSON, which re-conflicted every open PR on every main
  // advance. Only issue files in the diff are consulted (an old allowance on
  // main grants nothing), so a unique file per PR ⇒ no cross-PR conflicts.
  const { base } = resolveChangeBase(ROOT);
  const allow = base ? changeSetAllowances(ROOT, base, "oracle-ratchet-allow") : new Map();
  const fileOf = (f) => f.slice(0, f.indexOf(":"));
  const waived = failures.filter((f) => allow.has(fileOf(f)));
  const remaining = failures.filter((f) => !allow.has(fileOf(f)));
  for (const w of waived) {
    console.log(`[oracle-ratchet] waived by change-set allowance (${allow.get(fileOf(w)).join(", ")}): ${w}`);
  }
  if (remaining.length > 0) {
    console.error(
      `[oracle-ratchet] FAILED — direct checker usage grew in src/codegen/ (${remaining.length} file(s)).\n` +
        `New code must use ctx.oracle (src/checker/oracle.ts, #1930). If this growth is\n` +
        `genuinely intentional, migrate the site to the oracle, or — for a verbatim\n` +
        `relocation (god-file split, total usage conserved) — grant THIS change-set an\n` +
        `allowance by listing the path(s) under an \`oracle-ratchet-allow:\` key in the\n` +
        `YAML frontmatter of this PR's own plan/issues/*.md file. Offending files:\n  ` +
        remaining.join("\n  "),
    );
    process.exit(1);
  }
}

if (updateOnDecrease && decreased) {
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify({ files: merged, preauthorized: baseline.preauthorized ?? [] }, null, 2) + "\n",
  );
  console.log("[oracle-ratchet] decreases banked into baseline.");
}

const t = totals(current);
console.log(`[oracle-ratchet] OK — getTypeAtLocation=${t.getTypeAtLocation}, ctx.checker=${t.ctxChecker} (no growth).`);
