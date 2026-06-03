#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1081 — Write a commit-hash-indexed test262 run cache entry.
//
// Given a merged test262 report JSON, a merged results JSONL, and the commit
// SHA the run was performed against, this writes two side-files into the
// baselines repo's `runs/` directory:
//
//   runs/<sha>.json   — summary (pass/fail/CE counts, run metadata, categories)
//   runs/<sha>.jsonl  — per-test results (copied verbatim)
//
// These hash-indexed files let a PR's CI compare against main *at the PR's
// merge-base commit* instead of against a moving "latest main" pointer,
// eliminating drift attribution. See plan/issues/1081-index-test262-runs-by-commit.md.
//
// Usage:
//   node scripts/write-run-cache.mjs \
//     --report  <merged-report.json> \
//     --jsonl   <merged-results.jsonl> \
//     --sha     <commit-sha> \
//     --runs-dir <baselines-repo>/runs \
//     [--ref refs/heads/main] \
//     [--run-id 123] [--run-started-at ISO] [--run-duration-seconds N] \
//     [--test262-version <submodule-sha>]
//
// Exit codes:
//   0 — cache entry written (or intentionally skipped as corrupt)
//   2 — bad arguments / filesystem error

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

// Reject obviously-corrupt reports so a bad run never poisons the cache that
// every subsequent merge-base PR diff would trust (spec §Risks: cache corruption).
const MIN_PASS = 1000;
const MIN_TOTAL = 40000;

/**
 * Build the summary object written to runs/<sha>.json.
 * Exported for unit testing.
 */
export function buildRunSummary(report, meta) {
  const s = report.summary ?? {};
  const strict = report.strict_summary ?? {};
  const categories = {};
  // The report's `categories` map is { "<path>": { pass, fail, total, ... } }.
  // Persist it verbatim (minus any nested noise) so merge-base diffs can do
  // fast per-category queries without loading the 1.5 MB jsonl.
  for (const [k, v] of Object.entries(report.categories ?? {})) {
    if (v && typeof v === "object") {
      categories[k] = {
        pass: v.pass ?? 0,
        fail: v.fail ?? 0,
        compile_error: v.compile_error ?? 0,
        total: v.total ?? 0,
      };
    }
  }
  return {
    sha: meta.sha,
    ref: meta.ref ?? "refs/heads/main",
    pass: s.pass ?? 0,
    fail: s.fail ?? 0,
    compile_error: s.compile_error ?? 0,
    compile_timeout: s.compile_timeout ?? 0,
    skip: s.skip ?? 0,
    total: s.total ?? 0,
    strict_pass: strict.pass ?? 0,
    strict_total: strict.total ?? 0,
    run_id: meta.runId ?? null,
    run_started_at: meta.runStartedAt ?? null,
    run_duration_seconds: meta.runDurationSeconds ?? null,
    test262_version: meta.test262Version ?? null,
    categories,
  };
}

export function isCorrupt(summary) {
  return summary.pass < MIN_PASS || summary.total < MIN_TOTAL;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const reportPath = args.report;
  const jsonlPath = args.jsonl;
  const sha = args.sha;
  const runsDir = args["runs-dir"];

  if (!reportPath || !jsonlPath || !sha || !runsDir) {
    console.error(
      "usage: write-run-cache.mjs --report <json> --jsonl <jsonl> --sha <sha> --runs-dir <dir> [--ref ...] [--run-id ...] [--run-started-at ...] [--run-duration-seconds ...] [--test262-version ...]",
    );
    process.exit(2);
  }
  if (!existsSync(reportPath) || !existsSync(jsonlPath)) {
    console.error(`write-run-cache: missing input (report=${reportPath} jsonl=${jsonlPath})`);
    process.exit(2);
  }

  const report = JSON.parse(readFileSync(reportPath, "utf-8"));
  const summary = buildRunSummary(report, {
    sha,
    ref: args.ref,
    runId: args["run-id"] === "true" ? null : args["run-id"],
    runStartedAt: args["run-started-at"] === "true" ? null : args["run-started-at"],
    runDurationSeconds:
      args["run-duration-seconds"] && args["run-duration-seconds"] !== "true"
        ? Number(args["run-duration-seconds"])
        : null,
    test262Version: args["test262-version"] === "true" ? null : args["test262-version"],
  });

  if (isCorrupt(summary)) {
    console.error(
      `write-run-cache: report looks corrupt (pass=${summary.pass} total=${summary.total}); not writing cache entry for ${sha}.`,
    );
    // Exit 0: a corrupt run is not a CI failure here — the promote step has
    // its own abort guard; we simply decline to poison the hash cache.
    process.exit(0);
  }

  mkdirSync(runsDir, { recursive: true });
  const jsonOut = join(runsDir, `${sha}.json`);
  const jsonlOut = join(runsDir, `${sha}.jsonl`);
  writeFileSync(jsonOut, JSON.stringify(summary, null, 2));
  copyFileSync(jsonlPath, jsonlOut);
  console.log(`write-run-cache: wrote ${jsonOut} and ${jsonlOut} (pass=${summary.pass}/${summary.total}).`);
}

// Only run main() when invoked directly, not when imported for tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
