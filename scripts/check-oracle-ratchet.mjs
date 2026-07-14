#!/usr/bin/env node
// (#1930) Oracle ratchet — fails CI when direct TS-checker usage under
// src/codegen/ GROWS. New code must query ctx.oracle (src/checker/oracle.ts)
// instead of reaching into the raw TS checker.
//
// Counted patterns (occurrences, not lines), per file:
//   getTypeAtLocation:  /\bgetTypeAtLocation\s*\(/g
//   ctxChecker:         /\bctx\.checker\b/g
// Scope: src/codegen/**/*.ts (excluding *.d.ts). Symbol/binding resolution via
// a local `checker` param is intentionally NOT counted in v1 (name resolution
// is out of the oracle's scope — see issue #1930 D3 "explicitly OUT").
//
// CHANGE-SCOPED (#3273, mirroring the #3131 rework of check-loc-budget.mjs and
// check-coercion-sites.mjs). When a git diff base is resolvable
// (scripts/lib/change-scope.mjs), the DEFAULT run judges ONLY this change-set:
// for each changed src/codegen/*.ts file it counts the two checker patterns at
// the BASE blob vs the WORKING TREE, then fails only when the change-set's NET
// (per-field, summed over the changed files) direct-checker count GREW. The
// committed baseline (scripts/oracle-ratchet-baseline.json) is NOT consulted on
// that path.
//
//   NET, not per-file: a god-file split moves existing checker sites from the
//   source file (−N) into a new sibling module (+N). That is net-neutral — no
//   new oracle debt — so it must pass. A pure per-file "any increase fails"
//   rule would flag the new module (0→N) and force the split PR to grant an
//   allowance for every module it creates, which is exactly the treadmill this
//   rework removes. Netting per field passes verbatim relocations while a
//   genuinely NEW checker call (an edited file gains a site with no offsetting
//   removal) nets > 0 and still fails. This matches the ratchet's actual job:
//   prevent GROWTH of total direct-checker usage under src/codegen/, not freeze
//   the physical file each site lives in. Measured against the three parked
//   split PRs (#3069/#3067/#3066): each is exactly net-zero on both fields.
//
//   WHY the whole-tree comparison was merge-queue-UNSAFE: during the god-file
//   breakdown, every PR that re-merges main re-flagged NEW sibling split
//   modules (added by OTHER already-merged PRs) that the baseline never banked,
//   unless each PR re-declared a per-issue allowance for files it never
//   touched — a per-wave treadmill that bot-parked three byte-identical
//   refactor PRs (#3069/#3067/#3066) with Test262 green (no real regression).
//   See memory reference_ci_gate_change_scoped_not_wholetree_absolute. Scoping
//   to the change-set's own base means an unrelated main advance can never
//   re-flag a file the PR did not touch (the sibling module is identical at the
//   base and the working tree, so it is not in the diff at all).
//
// Intentional growth (a reviewed migration step that adds a direct-checker
// call) is granted per change-set — NOT via the shared baseline — by listing
// the repo-relative path(s) under an `oracle-ratchet-allow:` key in the YAML
// frontmatter of this PR's own plan/issues/*.md file (visible in the diff; a
// unique file per PR ⇒ no cross-PR conflicts). This replaces the committed
// `preauthorized` bump for the change-scoped path.
//
// The committed baseline + `preauthorized` list remain for the writer modes
// and the no-git fallback; main's post-merge refresh is its sole writer.
//
// Usage:
//   node scripts/check-oracle-ratchet.mjs                    # change-scoped gate (default)
//   node scripts/check-oracle-ratchet.mjs --all              # whole-tree audit vs committed baseline
//   node scripts/check-oracle-ratchet.mjs --update           # reseed the committed baseline (post-merge/main only)
//   node scripts/check-oracle-ratchet.mjs --update-on-decrease  # bank lower counts (post-merge job)
//   node scripts/check-oracle-ratchet.mjs --verbose          # print current totals
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChangeBase, changedPaths, baseBlob, changeSetAllowances } from "./lib/change-scope.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCOPE = join(ROOT, "src", "codegen");
const BASELINE_PATH = join(ROOT, "scripts", "oracle-ratchet-baseline.json");
// Repo-relative prefix for change-scoping; baseline keys are repo-relative too
// (relative(ROOT, file) === "src/codegen/…"), so they align with changedPaths.
const SCOPE_PREFIX = "src/codegen/";

const FIELDS = ["getTypeAtLocation", "ctxChecker"];

const args = process.argv.slice(2);
const update = args.includes("--update");
const updateOnDecrease = args.includes("--update-on-decrease");
const verbose = args.includes("--verbose");
const auditAll = args.includes("--all");

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

/** Per-field checker-usage counts for one file's text. Pure text → counts, so
 *  it applies identically to the working tree and to a git base blob. */
function countFields(src) {
  return {
    getTypeAtLocation: countIn(src, /\bgetTypeAtLocation\s*\(/g),
    ctxChecker: countIn(src, /\bctx\.checker\b/g),
  };
}

const ZERO = { getTypeAtLocation: 0, ctxChecker: 0 };

// Whole-tree current counts (used by --update / --update-on-decrease / --all /
// the no-git legacy fallback, and as the working-tree lookup for the scoped
// gate). Only files with at least one hit are recorded.
const current = {};
for (const file of walk(SCOPE)) {
  const c = countFields(readFileSync(file, "utf-8"));
  if (c.getTypeAtLocation > 0 || c.ctxChecker > 0) {
    current[relative(ROOT, file)] = c;
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

if (verbose) {
  const t = totals(current);
  console.error(
    `[oracle-ratchet] current totals: getTypeAtLocation=${t.getTypeAtLocation}, ctx.checker=${t.ctxChecker}`,
  );
}

// ── Writer mode: --update reseeds the committed baseline wholesale (post-merge/
//    main only). Preauthorized allowances are baked into `files`, so they reset.
if (update) {
  writeFileSync(BASELINE_PATH, JSON.stringify({ files: current, preauthorized: [] }, null, 2) + "\n");
  const t = totals(current);
  console.log(
    `[oracle-ratchet] baseline updated: ${Object.keys(current).length} files, ` +
      `getTypeAtLocation=${t.getTypeAtLocation}, ctx.checker=${t.ctxChecker}`,
  );
  process.exit(0);
}

/**
 * Change-scoped gate (#3273): for each changed src/codegen file, count the two
 * checker patterns at the base blob vs the working tree, then fail only when
 * the change-set's NET (per-field, summed over the changed files) direct-checker
 * count grew. Only THIS change-set is judged; the committed baseline is not
 * involved. Returns false when the diff cannot be computed (caller falls back to
 * the legacy whole-tree mode).
 */
function gateScoped() {
  const { base, how } = resolveChangeBase(ROOT);
  if (!base) return false;
  const changedAll = changedPaths(ROOT, base, "src/codegen");
  if (changedAll === undefined) return false;
  const changed = [...changedAll]
    .filter((p) => p.endsWith(".ts") && !p.endsWith(".d.ts") && p.startsWith(SCOPE_PREFIX))
    .sort();
  const allow = changeSetAllowances(ROOT, base, "oracle-ratchet-allow");

  // Per-field net delta across the change-set, EXCLUDING allowance-granted
  // files (their intentional growth is sanctioned, so it neither faults nor
  // counts toward the net). A verbatim relocation nets to 0 → pass; a new
  // checker call with no offsetting removal nets > 0 → fail.
  const net = { getTypeAtLocation: 0, ctxChecker: 0 };
  const increases = []; // non-allowed files that grew a field (for the report)
  const granted = [];

  for (const p of changed) {
    const now = current[p] ?? ZERO; // deleted / dropped-to-zero → ZERO
    const blob = baseBlob(ROOT, base, p);
    const was = blob === undefined ? ZERO : countFields(blob);
    const grew = FIELDS.filter((f) => now[f] > was[f]);
    const delta = FIELDS.map((f) => `${f} ${was[f]}→${now[f]}`).join(", ");
    if (allow.has(p)) {
      if (grew.length > 0) granted.push(`  ${p}: ${delta} granted by ${allow.get(p).join(", ")}`);
      continue; // sanctioned — excluded from the net
    }
    for (const f of FIELDS) net[f] += now[f] - was[f];
    if (grew.length > 0) {
      increases.push(`  ${p}: ${grew.map((f) => `${f} ${was[f]}→${now[f]}`).join(", ")}`);
    }
  }

  if (granted.length > 0) {
    console.log("[oracle-ratchet] intentional growth allowed by this change-set's issue file:\n" + granted.join("\n"));
  }

  const grownFields = FIELDS.filter((f) => net[f] > 0);
  if (grownFields.length > 0) {
    console.error(
      `[oracle-ratchet] FAILED — this change-set ADDS direct checker usage on net ` +
        `(${grownFields.map((f) => `${f} +${net[f]}`).join(", ")}).\n` +
        `Files whose checker usage increased:\n` +
        increases.join("\n") +
        "\n\nMoving existing sites between files is net-neutral and passes; this\n" +
        "change-set grows the total. New code must query ctx.oracle\n" +
        "(src/checker/oracle.ts, #1930) instead of the raw TS checker\n" +
        "(getTypeAtLocation / ctx.checker). If this growth is a genuinely\n" +
        "intentional, reviewed migration step, grant THIS change-set an allowance:\n" +
        "list the repo-relative path(s) under an `oracle-ratchet-allow:` key in the\n" +
        "YAML frontmatter of this PR's own issue file (any plan/issues/*.md the PR\n" +
        "adds or modifies), e.g.\n\n" +
        "  oracle-ratchet-allow:\n" +
        "    - src/codegen/expressions/calls.ts\n\n" +
        "Do NOT commit changes to scripts/oracle-ratchet-baseline.json in a PR — it\n" +
        "is refreshed on main only (#3273).",
    );
    process.exit(1);
  }

  console.log(
    `[oracle-ratchet] OK — no net checker-usage growth across ${changed.length} changed src/codegen file(s) ` +
      `(getTypeAtLocation ${net.getTypeAtLocation >= 0 ? "+" : ""}${net.getTypeAtLocation}, ` +
      `ctx.checker ${net.ctxChecker >= 0 ? "+" : ""}${net.ctxChecker}; base: ${how}).`,
  );
  return true;
}

// Default path: change-scoped. --update-on-decrease and --all fall through to
// the legacy whole-tree comparison (the former is a writer/banking mode, the
// latter an explicit whole-tree audit).
if (!updateOnDecrease && !auditAll && gateScoped()) {
  process.exit(0);
}

// ── Legacy whole-tree comparison against the committed baseline. Used by --all,
//    by --update-on-decrease (the post-merge banking writer), and as the
//    no-git fallback so the gate never crashes a hook outside a git context.
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
  const base = baseline.files[file] ?? ZERO;
  for (const field of FIELDS) {
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

if (failures.length > 0) {
  console.error(
    `[oracle-ratchet] FAILED (whole-tree) — direct checker usage grew in src/codegen/ (${failures.length} file(s)).\n` +
      `New code must use ctx.oracle (src/checker/oracle.ts, #1930). If this growth is\n` +
      `genuinely intentional, add a preauthorized entry with a reason, or migrate the\n` +
      `site to the oracle. Offending files:\n  ` +
      failures.join("\n  "),
  );
  process.exit(1);
}

if (updateOnDecrease && decreased) {
  writeFileSync(
    BASELINE_PATH,
    JSON.stringify({ files: merged, preauthorized: baseline.preauthorized ?? [] }, null, 2) + "\n",
  );
  console.log("[oracle-ratchet] decreases banked into baseline.");
}

const t = totals(current);
console.log(
  `[oracle-ratchet] OK (whole-tree${auditAll ? " --all" : " — no git base, committed-baseline mode"}) — ` +
    `getTypeAtLocation=${t.getTypeAtLocation}, ctx.checker=${t.ctxChecker} (no growth).`,
);
