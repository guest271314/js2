#!/usr/bin/env node
// Prune stale / orphaned agent-status heartbeat files.
//
// Background: `.claude/agent-status/<worktree-basename>.json` files are
// per-agent heartbeats the statusline reads (it buckets them active ▶ /
// ci-wait ⏸ / stale ✕). Dead agents never clean up their own file, so the
// dir accumulates hundreds of stale records across sprints (the "141✕"
// statusline pileup, 2026-05-29). This prunes them.
//
// A file is removed when EITHER:
//   - its basename has no matching live git worktree (orphaned), OR
//   - its heartbeat (last_seen, else since) is older than --max-age-min.
//
// Usage:
//   node scripts/prune-agent-status.mjs [--max-age-min=10] [--dry-run] [--quiet]
//
// Exit code is always 0 (best-effort housekeeping; never block a session).
import { readFileSync, readdirSync, statSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const maxAgeMin = Number((args.find((a) => a.startsWith("--max-age-min=")) || "").split("=")[1] || 10);
const dryRun = args.includes("--dry-run");
const quiet = args.includes("--quiet");
const log = (...m) => {
  if (!quiet) console.log("[prune-agent-status]", ...m);
};

// Resolve repo root from this script's location (scripts/ is at repo root).
const repoRoot = join(import.meta.dirname, "..");
// The agent-status dir is canonically the MAIN checkout's (the statusline
// hardcodes /workspace/.claude/agent-status). Prefer it so this works no
// matter which worktree/cwd invokes the script; fall back to repo-relative.
const canonical = "/workspace/.claude/agent-status";
const dir = existsSync(canonical) ? canonical : join(repoRoot, ".claude", "agent-status");
if (!existsSync(dir)) {
  log("no agent-status dir — nothing to prune");
  process.exit(0);
}

// NOTE: prune purely by HEARTBEAT AGE, matching the statusline's own
// staleness rule (the ✕ bucket). Status files are keyed by issue/agent-name,
// NOT by worktree basename, so a worktree-existence check would false-positive
// and delete a live agent's file. Age is the only reliable signal: an active
// agent keeps its last_seen fresh, so it's never pruned; a dead one ages out.
const nowSec = Math.floor(Date.now() / 1000);
const maxAgeSec = maxAgeMin * 60;
const toEpoch = (v) => {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const t = Date.parse(v); // ISO 8601 (e.g. ...T...Z)
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
};

let removed = 0,
  kept = 0;
for (const name of readdirSync(dir)) {
  if (!name.endsWith(".json")) continue;
  const path = join(dir, name);
  let reason = null;
  let hb = null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    hb = toEpoch(j.last_seen) ?? toEpoch(j.since);
  } catch {
    /* unparseable */
  }
  if (hb == null) hb = Math.floor(statSync(path).mtimeMs / 1000); // fall back to mtime
  if (nowSec - hb > maxAgeSec) reason = `stale (${Math.round((nowSec - hb) / 60)}m old)`;
  if (reason) {
    log(`${dryRun ? "would remove" : "remove"} ${name} — ${reason}`);
    if (!dryRun) rmSync(path, { force: true });
    removed++;
  } else {
    kept++;
  }
}
log(`${dryRun ? "would prune" : "pruned"} ${removed}, kept ${kept} (fresh/active).`);
process.exit(0);
