#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1081 — Retention prune for the commit-hash-indexed test262 run cache.
//
// Operates on a baselines-repo `runs/` directory containing `<sha>.json` +
// `<sha>.jsonl` pairs (plus `index.json`, which is never pruned). Policy
// (per plan/issues/1081-index-test262-runs-by-commit.md §Retention):
//
//   - Keep: entries whose commit is sprint-tagged (passed via --keep-shas),
//     forever.
//   - Keep: entries newer than --max-age-days (default 30).
//   - Evict: entries older than --max-age-days that are NOT sprint-tagged.
//   - Cap: after age eviction, if total size still exceeds --max-bytes
//     (default 500 MB), evict oldest-first (LRU by file mtime) until under cap,
//     skipping --keep-shas.
//
// This script only removes files; committing the cleanup is the workflow's job.
//
// Usage:
//   node scripts/prune-run-cache.mjs --runs-dir <dir> \
//     [--max-age-days 30] [--max-bytes 524288000] \
//     [--keep-shas <sha1,sha2,...>] [--dry-run]

import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
      args[key] = val;
    }
  }
  return args;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compute which SHA entries to evict. Pure function over an entry list for
 * unit testing; the caller supplies entries with { sha, bytes, mtimeMs }.
 *
 * @returns {string[]} SHAs to evict
 */
export function planEvictions(entries, opts) {
  const now = opts.now ?? Date.now();
  const maxAgeMs = (opts.maxAgeDays ?? 30) * DAY_MS;
  const maxBytes = opts.maxBytes ?? 500 * 1024 * 1024;
  const keep = new Set(opts.keepShas ?? []);

  const evict = new Set();

  // Phase 1: age-based eviction (sprint-tagged entries are immune).
  for (const e of entries) {
    if (keep.has(e.sha)) continue;
    if (now - e.mtimeMs > maxAgeMs) evict.add(e.sha);
  }

  // Phase 2: size cap — sum surviving entries, LRU-evict oldest until under cap.
  const survivors = entries.filter((e) => !evict.has(e.sha)).sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  let total = survivors.reduce((sum, e) => sum + e.bytes, 0);
  for (const e of survivors) {
    if (total <= maxBytes) break;
    if (keep.has(e.sha)) continue;
    evict.add(e.sha);
    total -= e.bytes;
  }

  return [...evict];
}

function collectEntries(runsDir) {
  const files = readdirSync(runsDir);
  const bySha = new Map();
  for (const f of files) {
    const m = /^([0-9a-f]{7,40})\.(json|jsonl)$/.exec(f);
    if (!m) continue;
    const sha = m[1];
    const full = join(runsDir, f);
    const st = statSync(full);
    const cur = bySha.get(sha) ?? { sha, bytes: 0, mtimeMs: 0, files: [] };
    cur.bytes += st.size;
    cur.mtimeMs = Math.max(cur.mtimeMs, st.mtimeMs);
    cur.files.push(full);
    bySha.set(sha, cur);
  }
  return [...bySha.values()];
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runsDir = args["runs-dir"];
  if (!runsDir || !existsSync(runsDir)) {
    console.log(`prune-run-cache: runs dir ${runsDir} missing — nothing to prune.`);
    process.exit(0);
  }
  const dryRun = args["dry-run"] === "true" || args["dry-run"] === true;
  const keepShas = (args["keep-shas"] && args["keep-shas"] !== "true" ? args["keep-shas"] : "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const entries = collectEntries(runsDir);
  const evictShas = new Set(
    planEvictions(entries, {
      maxAgeDays: args["max-age-days"] ? Number(args["max-age-days"]) : 30,
      maxBytes: args["max-bytes"] ? Number(args["max-bytes"]) : undefined,
      keepShas,
    }),
  );

  let freed = 0;
  for (const e of entries) {
    if (!evictShas.has(e.sha)) continue;
    for (const f of e.files) {
      freed += statSync(f).size;
      if (!dryRun) rmSync(f);
    }
    console.log(`${dryRun ? "[dry-run] would evict" : "evicted"} run cache entry ${e.sha}`);
  }
  const remaining = entries.length - evictShas.size;
  console.log(
    `prune-run-cache: ${evictShas.size} entries ${dryRun ? "would be " : ""}evicted (${(freed / 1024 / 1024).toFixed(1)} MB), ${remaining} retained.`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
