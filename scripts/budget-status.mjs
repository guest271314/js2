#!/usr/bin/env node
// budget-status.mjs — pull-time budget + parallelism awareness (#2751).
//
// An agent about to claim a new task runs this FIRST to learn:
//   • the remaining token budget in the current window,
//   • the current parallelism (how many agents are active),
//   • the per-agent budget share, and
//   • the largest task HORIZON it should pull so it does not overrun the window.
//
// Then it claims an adequately-sized task: highest-priority `sprint: current`
// task whose `[horizon]` fits. This realises "prefer long-horizon tasks at the
// beginning of a budget" structurally — at a fresh window the per-agent share is
// large so XL/L tasks fit and are surfaced first (big rocks first); as the window
// drains (or parallelism rises) the share shrinks and only smaller tasks are
// recommended, with S tasks as the always-available tail filler. A task too big
// for the remaining share is deferred to the next window's start, never started
// late where it would strand.
//
// BUDGET SOURCE: the statusline (.claude/statusline-command.sh, which shows "wkly"
// % and "d left") caches rate_limits.seven_day to ~/.claude/js2wasm-budget.json on
// every render; this script reads it automatically. Env vars below override it; with
// neither cache nor env it assumes a fresh window (R=100%) so it recommends big rocks
// rather than falsely deferring.
//
// INPUTS (env; all optional):
//   JS2WASM_BUDGET_REMAINING_PCT   remaining budget, 0..100   (overrides cache)
//   JS2WASM_BUDGET_PCT             spent budget, 0..100        (remaining = 100 - spent)
//   JS2WASM_PARALLELISM            active-agent count override (else auto-detected)
//   JS2WASM_HORIZON_COSTS          JSON override of class costs, e.g. {"xl":0.25,...}
//
// Usage:
//   node scripts/budget-status.mjs            # human summary + recommended max horizon
//   node scripts/budget-status.mjs --pick      # also print the best-fit claimable task(s)
//   node scripts/budget-status.mjs --json       # machine-readable
//   node scripts/budget-status.mjs --quiet      # one line (for statuslines/hooks)

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const PICK = args.includes("--pick");
const JSON_OUT = args.includes("--json");
const QUIET = args.includes("--quiet");

const CLAUDE_HOME = process.env.CLAUDE_HOME || join(homedir(), ".claude");
const TASKS_ROOT = join(CLAUDE_HOME, "tasks");
const TEAM = process.env.JS2WASM_TEAM || "js2wasm";
const TEAM_DIR = join(TASKS_ROOT, TEAM);
const REPO = process.env.REPO_ROOT || process.cwd();
const ISSUES_DIR = join(REPO, "plan", "issues");

// Horizon cost as a FRACTION OF A FULL BUDGET WINDOW. Tunable via env; the
// relative ordering is what matters more than the absolute numbers.
const DEFAULT_COSTS = { xl: 0.25, l: 0.12, m: 0.05, s: 0.015 };
const HORIZON_COSTS = (() => {
  try {
    return {
      ...DEFAULT_COSTS,
      ...(process.env.JS2WASM_HORIZON_COSTS ? JSON.parse(process.env.JS2WASM_HORIZON_COSTS) : {}),
    };
  } catch {
    return DEFAULT_COSTS;
  }
})();
const CLASSES_BIG_FIRST = ["xl", "l", "m", "s"]; // cost-descending
const SLACK = 0.03;
const PRIO_RANK = { high: 1, medium: 2, low: 3 };

// --- weekly budget cache (written by the statusline, #2751) -------------------
// .claude/statusline-command.sh caches rate_limits.seven_day here on every render
// (the "wkly" / "d left" indicators); standalone scripts can't see that stdin JSON
// otherwise. { seven_day_used_pct, resets_at, written_at }.
function readBudgetCache() {
  try {
    const c = JSON.parse(readFileSync(join(CLAUDE_HOME, "js2wasm-budget.json"), "utf8"));
    return c && Number.isFinite(Number(c.seven_day_used_pct)) ? c : null;
  } catch {
    return null;
  }
}
const BUDGET_CACHE = readBudgetCache();

// --- remaining budget fraction R (0..1) ---------------------------------------
// Precedence: explicit env override → statusline weekly cache → fresh-window.
function remainingFraction() {
  const rem = Number(process.env.JS2WASM_BUDGET_REMAINING_PCT);
  if (Number.isFinite(rem)) return Math.max(0, Math.min(1, rem / 100));
  const spent = Number(process.env.JS2WASM_BUDGET_PCT);
  if (Number.isFinite(spent)) return Math.max(0, Math.min(1, (100 - spent) / 100));
  if (BUDGET_CACHE) return Math.max(0, Math.min(1, (100 - Number(BUDGET_CACHE.seven_day_used_pct)) / 100));
  return 1; // no budget source → assume a fresh window
}
const budgetKnown =
  Number.isFinite(Number(process.env.JS2WASM_BUDGET_REMAINING_PCT)) ||
  Number.isFinite(Number(process.env.JS2WASM_BUDGET_PCT)) ||
  BUDGET_CACHE != null;

// Days left in the weekly window (from the statusline cache's reset timestamp).
function daysLeft() {
  if (!BUDGET_CACHE || !Number.isFinite(Number(BUDGET_CACHE.resets_at))) return null;
  const secs = Number(BUDGET_CACHE.resets_at) - Date.now() / 1000;
  return secs > 0 ? secs / 86400 : 0;
}

// --- task stores --------------------------------------------------------------
function taskStoreDirs() {
  if (!existsSync(TASKS_ROOT)) return [];
  const dirs = [];
  for (const name of readdirSync(TASKS_ROOT)) {
    const p = join(TASKS_ROOT, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(name) || /^session-/.test(name);
    const fresh = Date.now() - st.mtimeMs < 7 * 24 * 3600 * 1000;
    if (name === TEAM || (isUuid && fresh)) dirs.push(p);
  }
  return dirs;
}
function allTasks() {
  const byId = new Map();
  for (const dir of taskStoreDirs()) {
    let files;
    try {
      files = readdirSync(dir).filter((f) => /\.json$/i.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const t = JSON.parse(readFileSync(join(dir, f), "utf8"));
        if (t && t.id) byId.set(String(t.id) + "@" + (dir === TEAM_DIR ? "team" : "sess"), t);
      } catch {
        /* skip */
      }
    }
  }
  return [...byId.values()];
}

// --- parallelism: distinct owners of in_progress tasks (min 1) ----------------
function parallelism() {
  const env = Number(process.env.JS2WASM_PARALLELISM);
  if (Number.isFinite(env) && env >= 1) return Math.floor(env);
  const owners = new Set();
  for (const t of allTasks()) {
    if (t.status === "in_progress" && t.owner) owners.add(t.owner);
  }
  return Math.max(1, owners.size);
}

// --- recommended max horizon for a per-agent share ----------------------------
function maxHorizonFor(share) {
  for (const c of CLASSES_BIG_FIRST) {
    if (HORIZON_COSTS[c] <= share + SLACK) return c;
  }
  return "s"; // even S over budget → still allow the tail filler, but flag it
}

// --- frontmatter (minimal) ----------------------------------------------------
function parseFM(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  if (!m) return fm;
  for (const line of m[1].split("\n")) {
    const mm = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    fm[mm[1].toLowerCase()] = v;
  }
  return fm;
}
function normHorizon(v) {
  const s = (v || "").toString().trim().toLowerCase();
  if (["xl", "xlarge", "x-large", "epic"].includes(s)) return "xl";
  if (["l", "large", "big"].includes(s)) return "l";
  if (["s", "small", "tiny", "trivial"].includes(s)) return "s";
  return "m";
}
function claimableIssues() {
  if (!existsSync(ISSUES_DIR)) return [];
  const out = [];
  for (const f of readdirSync(ISSUES_DIR)) {
    if (!/^\d+[a-z]?-.+\.md$/i.test(f)) continue;
    let text;
    try {
      text = readFileSync(join(ISSUES_DIR, f), "utf8");
    } catch {
      continue;
    }
    const fm = parseFM(text);
    if ((fm.sprint || "").toLowerCase() !== "current") continue;
    if ((fm.status || "").toLowerCase() !== "ready") continue; // claimable = ready & unowned
    out.push({
      id: (fm.id || f.match(/^(\d+[a-z]?)-/i)?.[1] || "").toLowerCase(),
      title: fm.title || "",
      priority: (fm.priority || "medium").toLowerCase(),
      horizon: normHorizon(fm.horizon || fm.cost),
    });
  }
  return out;
}

// --- compute ------------------------------------------------------------------
const R = remainingFraction();
const N = parallelism();
const share = R / N;
const maxHz = maxHorizonFor(share);
const fitsCost = HORIZON_COSTS[maxHz];
const fresh = maxHz === "xl" || maxHz === "l"; // window has runway for big rocks
const allowed = CLASSES_BIG_FIRST.filter((c) => HORIZON_COSTS[c] <= HORIZON_COSTS[maxHz]); // <= maxHz cost

function pickTasks() {
  let cands = claimableIssues().filter((i) => allowed.includes(i.horizon));
  cands.sort((a, b) => {
    if (fresh) {
      // big rocks first, then priority
      const hc = HORIZON_COSTS[b.horizon] - HORIZON_COSTS[a.horizon];
      if (hc) return hc;
      return PRIO_RANK[a.priority] - PRIO_RANK[b.priority];
    }
    // draining: priority first, then smallest (tail-pack)
    const pr = PRIO_RANK[a.priority] - PRIO_RANK[b.priority];
    if (pr) return pr;
    return HORIZON_COSTS[a.horizon] - HORIZON_COSTS[b.horizon];
  });
  return cands;
}

const picks = PICK || JSON_OUT ? pickTasks() : [];

// --- output -------------------------------------------------------------------
const pctRem = Math.round(R * 100);
const dl = daysLeft();
const src = budgetKnown
  ? BUDGET_CACHE &&
    !Number.isFinite(Number(process.env.JS2WASM_BUDGET_REMAINING_PCT)) &&
    !Number.isFinite(Number(process.env.JS2WASM_BUDGET_PCT))
    ? " (source: statusline weekly cache)"
    : ""
  : " (no budget source — assuming fresh window; statusline writes ~/.claude/js2wasm-budget.json, or set JS2WASM_BUDGET_REMAINING_PCT)";

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        remaining_pct: pctRem,
        budget_known: budgetKnown,
        days_left: dl == null ? null : Number(dl.toFixed(2)),
        parallelism: N,
        per_agent_share: Number(share.toFixed(3)),
        recommended_max_horizon: maxHz,
        recommended_max_horizon_cost: fitsCost,
        allowed_horizons: allowed,
        phase: fresh ? "fresh-big-rocks-first" : "draining-small-first",
        picks: picks
          .slice(0, 5)
          .map((p) => ({ id: p.id, horizon: p.horizon, priority: p.priority, title: p.title.slice(0, 70) })),
      },
      null,
      2,
    ),
  );
} else if (QUIET) {
  console.log(
    `budget ${pctRem}% rem${dl == null ? "" : ` | ${dl.toFixed(1)}d left`} | ${N} agents | share ${(share * 100).toFixed(0)}% | pull ≤ ${maxHz.toUpperCase()}${budgetKnown ? "" : " (assumed)"}`,
  );
} else {
  console.log(`\nbudget-status${src}`);
  console.log(`  remaining budget : ${pctRem}%${dl == null ? "" : `   (${dl.toFixed(1)}d left in window)`}`);
  console.log(`  parallelism      : ${N} active agent(s)`);
  console.log(`  per-agent share  : ${(share * 100).toFixed(0)}% of a window`);
  console.log(`  → pull a task ≤ horizon ${maxHz.toUpperCase()} (cost ≤ ${(fitsCost * 100).toFixed(1)}% of window)`);
  console.log(
    `  phase            : ${fresh ? "fresh → big rocks first (XL/L before M/S)" : "draining → priority + smallest-first tail-pack"}`,
  );
  if (maxHz === "s" && share + SLACK < HORIZON_COSTS.s) {
    console.log(`  ⚠ budget nearly exhausted — only S tail-filler advisable; defer larger work to the next window.`);
  }
  if (PICK) {
    console.log(`\n  best-fit claimable tasks (sprint: current, ready, horizon ≤ ${maxHz.toUpperCase()}):`);
    if (!picks.length) console.log(`    (none — queue may be empty or all remaining tasks exceed the budget share)`);
    for (const p of picks.slice(0, 5)) {
      console.log(`    #${p.id}  [${p.priority}] [${p.horizon.toUpperCase()}]  ${p.title.slice(0, 66)}`);
    }
  }
  console.log("");
}

process.exit(0);
