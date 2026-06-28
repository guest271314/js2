#!/usr/bin/env node
// freeze-sprint.mjs — budget-triggered sprint freeze (#2751).
//
// The rolling sprint model keeps all live work tagged `sprint: current`. When the
// weekly TOKEN BUDGET window closes, this script "freezes" the window:
//
//   1. compute the LOWEST FREE sprint index N (smallest N >= 0 with no issue
//      carrying `sprint: N` and no plan/issues/sprints/N.md),
//   2. re-tag every issue that is `sprint: current` AND `status: done` to
//      `sprint: N` (the window's frozen record of completed work),
//   3. leave every NOT-done `sprint: current` issue as `sprint: current` (it rolls
//      forward into the next window — so stranding is structurally impossible),
//   4. write plan/issues/sprints/N.md as the retrospective record of the window.
//
// TRIGGER (budget is primary; the time floor is the fallback so a slow week still
// rolls over). The script fires when EITHER:
//   - token budget consumed >= 99%   (env JS2WASM_BUDGET_PCT, a number 0..100), OR
//   - <= 1 hour left in the window    (env JS2WASM_WINDOW_ENDS_AT, an ISO datetime)
// Pass --force to freeze unconditionally. With no trigger source and no --force it
// is a no-op (and says so) — the token-budget source still needs wiring (#2751
// open dependency); until then run it from the tech-lead loop with --force at
// rollover, or export JS2WASM_BUDGET_PCT / JS2WASM_WINDOW_ENDS_AT.
//
// Usage:
//   node scripts/freeze-sprint.mjs --dry-run   # show N + what would freeze
//   node scripts/freeze-sprint.mjs --force      # freeze now
//   JS2WASM_BUDGET_PCT=99 node scripts/freeze-sprint.mjs
//   JS2WASM_WINDOW_ENDS_AT=2026-06-27T18:00:00Z node scripts/freeze-sprint.mjs

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const FORCE = args.includes("--force");

const REPO = process.env.REPO_ROOT || process.cwd();
const ISSUES_DIR = join(REPO, "plan", "issues");
const SPRINTS_DIR = join(ISSUES_DIR, "sprints");
const CLAUDE_HOME = process.env.CLAUDE_HOME || join(homedir(), ".claude");

// Weekly budget cache written by the statusline (#2751): { seven_day_used_pct,
// resets_at, written_at }. Lets the freeze trigger read the same "wkly" / "d left"
// data the statusline shows, without a manual env var.
function readBudgetCache() {
  try {
    const c = JSON.parse(readFileSync(join(CLAUDE_HOME, "js2wasm-budget.json"), "utf8"));
    return c && Number.isFinite(Number(c.seven_day_used_pct)) ? c : null;
  } catch {
    return null;
  }
}

const today = new Date().toISOString().slice(0, 10);

// --- trigger evaluation -------------------------------------------------------
// Precedence: --force → explicit env → statusline weekly cache. Fires at
// >=99% weekly budget spent OR <=1h until the weekly window resets.
function triggerReason() {
  if (FORCE) return "--force";
  const pct = Number(process.env.JS2WASM_BUDGET_PCT);
  if (Number.isFinite(pct) && pct >= 99) return `budget ${pct}% >= 99%`;
  const ends = process.env.JS2WASM_WINDOW_ENDS_AT;
  if (ends) {
    const t = Date.parse(ends);
    if (Number.isFinite(t)) {
      const msLeft = t - Date.now();
      if (msLeft <= 3600 * 1000) return `${Math.round(msLeft / 60000)} min left (<= 60)`;
    }
  }
  // Statusline weekly cache (the "wkly" % and "d left" the statusline shows).
  const cache = readBudgetCache();
  if (cache) {
    const used = Number(cache.seven_day_used_pct);
    if (used >= 99) return `weekly budget ${used}% >= 99% (statusline)`;
    if (Number.isFinite(Number(cache.resets_at))) {
      const minLeft = (Number(cache.resets_at) - Date.now() / 1000) / 60;
      if (minLeft > 0 && minLeft <= 60) return `${Math.round(minLeft)} min left in weekly window (statusline)`;
    }
  }
  return null;
}

// --- frontmatter helpers ------------------------------------------------------
function splitFrontmatter(text) {
  const m = text.match(/^(---\n[\s\S]*?\n---)([\s\S]*)$/);
  if (!m) return null;
  return { fm: m[1], body: m[2] };
}
function fmField(fm, key) {
  const m = fm.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  if (!m) return null;
  let v = m[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v;
}

function listIssues() {
  if (!existsSync(ISSUES_DIR)) return [];
  return readdirSync(ISSUES_DIR)
    .filter((f) => /^\d+[a-z]?-.+\.md$/i.test(f))
    .map((f) => {
      const path = join(ISSUES_DIR, f);
      let text;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return null;
      }
      const parts = splitFrontmatter(text);
      if (!parts) return null;
      return {
        file: f,
        path,
        text,
        parts,
        id: (fmField(parts.fm, "id") || f.match(/^(\d+[a-z]?)-/i)?.[1] || "").toLowerCase(),
        title: fmField(parts.fm, "title") || "",
        status: (fmField(parts.fm, "status") || "").toLowerCase(),
        sprint: (fmField(parts.fm, "sprint") || "").toLowerCase(),
      };
    })
    .filter(Boolean);
}

// --- lowest free sprint index -------------------------------------------------
function lowestFreeIndex(issues) {
  const used = new Set();
  for (const i of issues) {
    if (/^\d+$/.test(i.sprint)) used.add(Number(i.sprint));
  }
  if (existsSync(SPRINTS_DIR)) {
    for (const f of readdirSync(SPRINTS_DIR)) {
      const m = f.match(/^(\d+)\.md$/);
      if (m) used.add(Number(m[1]));
    }
  }
  let n = 0;
  while (used.has(n)) n++;
  return n;
}

// --- run ----------------------------------------------------------------------
const reason = triggerReason();
if (!reason) {
  console.log(
    "freeze-sprint: no trigger (budget < 99%, > 1h left, no --force). No-op.\n" +
      "  Set JS2WASM_BUDGET_PCT / JS2WASM_WINDOW_ENDS_AT, or pass --force to freeze now.",
  );
  process.exit(0);
}

const issues = listIssues();
const N = lowestFreeIndex(issues);
const toFreeze = issues.filter((i) => i.sprint === "current" && i.status === "done");
const rollingForward = issues.filter((i) => i.sprint === "current" && i.status !== "done");

console.log(`freeze-sprint: trigger=[${reason}]  freezing into sprint ${N}`);
console.log(
  `  ${toFreeze.length} done issue(s) -> sprint:${N};  ${rollingForward.length} not-done stay sprint:current${DRY ? "  (dry-run)" : ""}`,
);

if (toFreeze.length) {
  console.log("  frozen:");
  for (const i of toFreeze) console.log(`    #${i.id}  ${i.title.slice(0, 70)}`);
}

if (DRY) {
  console.log(`  (dry-run — no files written; would create plan/issues/sprints/${N}.md)`);
  process.exit(0);
}

// 2 + 3: re-tag done current issues -> N (frontmatter only).
let retagged = 0;
for (const i of toFreeze) {
  let fm = i.parts.fm.replace(/^sprint:\s*current\s*$/m, `sprint: ${N}`);
  if (/^updated:/m.test(fm)) fm = fm.replace(/^updated:\s*.*$/m, `updated: ${today}`);
  const next = fm + i.parts.body;
  if (next !== i.text) {
    writeFileSync(i.path, next);
    retagged++;
  }
}

// 4: write the retrospective record.
const lines = [];
lines.push(`# Sprint ${N}`);
lines.push("");
lines.push(`Frozen ${today} — trigger: ${reason}.`);
lines.push("");
lines.push(`This is a **budget window** record (rolling-sprint model, #2751): the set`);
lines.push(`of issues completed before the token budget rolled over, frozen from`);
lines.push(`\`sprint: current\` into \`sprint: ${N}\`. Not-done work rolled forward and`);
lines.push(`stays \`sprint: current\`.`);
lines.push("");
lines.push(`## Completed this window (${toFreeze.length})`);
lines.push("");
if (toFreeze.length) {
  for (const i of toFreeze) lines.push(`- #${i.id} — ${i.title}`);
} else {
  lines.push("_None._");
}
lines.push("");
lines.push(`## Rolled forward (${rollingForward.length} still \`sprint: current\`)`);
lines.push("");
if (rollingForward.length) {
  for (const i of rollingForward) lines.push(`- #${i.id} [${i.status}] — ${i.title}`);
} else {
  lines.push("_None — queue drained this window._");
}
lines.push("");
lines.push(`## Retrospective`);
lines.push("");
const pct = process.env.JS2WASM_BUDGET_PCT;
if (pct) lines.push(`- Token budget at freeze: ${pct}%`);
lines.push(`- test262 conformance at freeze: see \`benchmarks/results/test262-current.json\`.`);
lines.push(`- _(Tech-lead: add what went well / what didn't / action items here.)_`);
lines.push("");

if (!existsSync(SPRINTS_DIR)) {
  console.log(`  WARN: ${SPRINTS_DIR} missing — skipping retro doc.`);
} else {
  writeFileSync(join(SPRINTS_DIR, `${N}.md`), lines.join("\n"));
}

console.log(`  done: re-tagged ${retagged} issue(s) -> sprint:${N}; wrote sprints/${N}.md`);
console.log(`  NOTE: run \`node scripts/sync-current-tasklist.mjs\` to refresh the TaskList (frozen issues drop out).`);
process.exit(0);
