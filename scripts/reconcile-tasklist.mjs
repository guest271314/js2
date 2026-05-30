#!/usr/bin/env node
// reconcile-tasklist.mjs — close the gap that makes TaskList entries go stale.
//
// ROOT CAUSE (2026-05-29): a task's flip to `completed` is a manual TaskUpdate
// someone must remember to make, but nothing structurally triggers it:
//   1. Async merge — devs enqueue then move on; the PR merges minutes later in
//      the merge queue, after the authoring agent is gone, so the post-merge
//      flip never happens.
//   2. Tracking-tasks have no owner — PO/lead-created tasks are completed via
//      the *issue file* (`status: done`, set in the impl PR — the real source
//      of truth), and no agent treats the TaskList twin as its job.
//   3. Split store — tasks live in TWO stores (per-session UUID dir + the
//      `js2wasm` team dir); a task created in one isn't reconciled by an agent
//      reading the other.
// Net: issue-frontmatter `status:` (accurate) and TaskList `status` (stale)
// drift, with no link and nobody noticing.
//
// This tool derives "done" from the AUTHORITATIVE sources (issue frontmatter +
// closed/merged PRs) and reports every non-completed task whose target issue is
// already done/wont-fix — i.e. stale entries that should be flipped to
// `completed`. Wired as a SessionStart hook (see .claude/settings.json) so the
// staleness is surfaced into the tech-lead's context every session instead of
// silently accumulating. The lead applies the flips via TaskUpdate (the
// authoritative write path); `--apply` can rewrite the task JSON directly as a
// best-effort fallback when no agent session is live to run TaskUpdate.
//
// Usage:
//   node scripts/reconcile-tasklist.mjs            # full human report
//   node scripts/reconcile-tasklist.mjs --quiet    # one line: "N stale: id,id" (for hooks)
//   node scripts/reconcile-tasklist.mjs --json      # machine-readable
//   node scripts/reconcile-tasklist.mjs --apply     # best-effort: rewrite stale task JSON status=completed
//
// Safe everywhere: if no task store is present (e.g. CI runners), it exits 0
// with "no task store" and never fails a build.

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const QUIET = args.has("--quiet");
const JSON_OUT = args.has("--json");
const APPLY = args.has("--apply");

const CLAUDE_HOME = process.env.CLAUDE_HOME || join(homedir(), ".claude");
const TASKS_ROOT = join(CLAUDE_HOME, "tasks");
const TEAM = process.env.JS2WASM_TEAM || "js2wasm";
const REPO = process.env.REPO_ROOT || process.cwd();
const ISSUES_DIR = join(REPO, "plan", "issues");

const DONE_STATUSES = new Set(["done", "wont-fix", "closed"]);

function out(s) {
  if (!QUIET && !JSON_OUT) console.log(s);
}

// --- locate task stores: the team dir + any recent session (UUID) dirs -------
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
    // Always include the team dir. Include UUID session dirs touched in the
    // last 7 days (skip stale historical sprint-* dirs).
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(name);
    const fresh = Date.now() - st.mtimeMs < 7 * 24 * 3600 * 1000;
    if (name === TEAM || (isUuid && fresh)) dirs.push(p);
  }
  return dirs;
}

// --- read every task across stores (dedupe by id; last-writer wins) ----------
function loadTasks() {
  const byId = new Map();
  for (const dir of taskStoreDirs()) {
    let files;
    try {
      files = readdirSync(dir).filter((f) => /^\d+[a-z]?\.json$/i.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(dir, f);
      let t;
      try {
        t = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        continue;
      }
      if (!t || !t.id) continue;
      byId.set(String(t.id), { ...t, _path: path });
    }
  }
  return [...byId.values()];
}

// --- resolve a target issue id's authoritative status from its file ----------
const issueStatusCache = new Map();
function issueStatus(id) {
  if (issueStatusCache.has(id)) return issueStatusCache.get(id);
  let status = null;
  if (existsSync(ISSUES_DIR)) {
    // match <id>.md or <id>-slug.md (id may carry a letter suffix, e.g. 1690b)
    const re = new RegExp(`^${id}(?:-.+)?\\.md$`, "i");
    let file = null;
    for (const f of readdirSync(ISSUES_DIR)) {
      if (re.test(f)) {
        file = join(ISSUES_DIR, f);
        break;
      }
    }
    if (file) {
      const text = readFileSync(file, "utf8");
      status = (text.match(/^status:\s*(\S+)/m)?.[1] || "").toLowerCase() || null;
    }
  }
  issueStatusCache.set(id, status);
  return status;
}

// Extract the task's TARGET issue id: the first #NNNN in the subject. The
// subject convention is `verb(#NNNN): …` / `fix(#NNNN) …`, so the first ref is
// the target (later refs are blockers/related and must NOT drive completion).
function targetIssueId(task) {
  const m = (task.subject || "").match(/#(\d+[a-z]?)/i);
  return m ? m[1].toLowerCase() : null;
}

// A task subject that itself announces completion (CLOSED/DONE/SUPERSEDED/STALE)
// but is still not status=completed is also stale.
function subjectSaysDone(task) {
  return /\b(CLOSED|SUPERSEDED|STALE|\[DONE\])\b/.test(task.subject || "");
}

const tasks = loadTasks();
if (tasks.length === 0) {
  out("reconcile-tasklist: no task store found (ok on CI) — nothing to do.");
  if (QUIET) console.log("0 stale");
  if (JSON_OUT) console.log(JSON.stringify({ stale: [], total: 0 }));
  process.exit(0);
}

const open = tasks.filter((t) => t.status !== "completed" && t.status !== "deleted");
const stale = [];
for (const t of open) {
  const iid = targetIssueId(t);
  const st = iid ? issueStatus(iid) : null;
  const reasonDone = st && DONE_STATUSES.has(st);
  const saysDone = subjectSaysDone(t);
  if (reasonDone || saysDone) {
    stale.push({
      id: t.id,
      issue: iid,
      issueStatus: st,
      reason: reasonDone ? `issue #${iid} is ${st}` : "subject marks CLOSED/DONE/SUPERSEDED",
      subject: (t.subject || "").slice(0, 80),
      path: t._path,
    });
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ total: tasks.length, open: open.length, stale }, null, 2));
} else if (QUIET) {
  console.log(stale.length === 0 ? "0 stale" : `${stale.length} stale: ${stale.map((s) => s.id).join(",")}`);
} else {
  out(`\nreconcile-tasklist: ${tasks.length} tasks, ${open.length} open, ${stale.length} STALE (done-but-not-completed)\n`);
  for (const s of stale) {
    out(`  #${s.id}  [${s.reason}]  ${s.subject}`);
  }
  if (stale.length) {
    out(`\nApply (authoritative — run as the team lead):`);
    for (const s of stale) out(`  TaskUpdate taskId=${s.id} status=completed`);
    out(`\nOr best-effort direct rewrite: node scripts/reconcile-tasklist.mjs --apply`);
  }
}

if (APPLY && stale.length) {
  let n = 0;
  for (const s of stale) {
    try {
      const t = JSON.parse(readFileSync(s.path, "utf8"));
      t.status = "completed";
      writeFileSync(s.path, JSON.stringify(t, null, 2));
      n++;
    } catch {
      /* skip */
    }
  }
  out(`\n--apply: rewrote ${n} task file(s) to status=completed (best-effort; TaskUpdate is authoritative).`);
}

// Never fail a build/hook on staleness — this is advisory.
process.exit(0);
