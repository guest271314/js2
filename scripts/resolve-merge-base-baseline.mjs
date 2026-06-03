#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1081 — Resolve which test262 baseline JSONL a PR's regression-gate should
// diff against, preferring the commit-hash-indexed cache entry for the PR's
// merge-base over the moving "latest main" pointer.
//
// Logic:
//   1. Given the merge-base SHA and a checkout of the baselines repo, look for
//      runs/<merge-base-sha>.jsonl + runs/<merge-base-sha>.json.
//   2. Cache HIT: the entry's test262_version must match the current
//      submodule SHA (else the baseline is for a different test262 corpus and
//      would shadow real regressions — spec §Risks: cache shadowing). On a
//      match, emit the cached jsonl as the baseline.
//   3. Cache MISS (or version mismatch): fall back to test262-current.jsonl,
//      print a warning so cache-miss frequency is observable.
//
// Output: prints `baseline_path=<abs>` and `cache=hit|miss` to GITHUB_OUTPUT
// when present, and always echoes a human-readable line to stdout. Never
// fails the build — a miss is a performance regression, not a correctness one.
//
// Usage:
//   node scripts/resolve-merge-base-baseline.mjs \
//     --baselines-dir /tmp/js2wasm-baselines \
//     --merge-base <sha> \
//     [--test262-version <submodule-sha>] \
//     [--dest benchmarks/results/test262-current.jsonl]

import { appendFileSync, copyFileSync, existsSync, readFileSync } from "node:fs";
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

function emitOutput(key, value) {
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `${key}=${value}\n`);
}

/**
 * Decide whether the cached entry for `mergeBase` is usable.
 * Exported for unit testing.
 *
 * @returns {{ hit: boolean; reason: string }}
 */
export function evaluateCacheEntry(baselinesDir, mergeBase, currentTest262Version) {
  const jsonlPath = join(baselinesDir, "runs", `${mergeBase}.jsonl`);
  const jsonPath = join(baselinesDir, "runs", `${mergeBase}.json`);
  if (!mergeBase || !existsSync(jsonlPath)) {
    return { hit: false, reason: "no cache entry for merge-base" };
  }
  // Version guard: only honor the cache when the test262 corpus matches.
  if (currentTest262Version && existsSync(jsonPath)) {
    try {
      const meta = JSON.parse(readFileSync(jsonPath, "utf-8"));
      if (meta.test262_version && meta.test262_version !== currentTest262Version) {
        return {
          hit: false,
          reason: `cache test262_version ${meta.test262_version} != current ${currentTest262Version}`,
        };
      }
    } catch {
      return { hit: false, reason: "cache summary JSON unreadable" };
    }
  }
  return { hit: true, reason: "merge-base cache entry present and version-compatible" };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const baselinesDir = args["baselines-dir"];
  const mergeBase = args["merge-base"] && args["merge-base"] !== "true" ? args["merge-base"] : "";
  const test262Version = args["test262-version"] && args["test262-version"] !== "true" ? args["test262-version"] : "";
  const dest = args.dest && args.dest !== "true" ? args.dest : "benchmarks/results/test262-current.jsonl";

  if (!baselinesDir) {
    console.error(
      "usage: resolve-merge-base-baseline.mjs --baselines-dir <dir> --merge-base <sha> [--test262-version <sha>] [--dest <path>]",
    );
    process.exit(2);
  }

  const { hit, reason } = evaluateCacheEntry(baselinesDir, mergeBase, test262Version);

  if (hit) {
    const cached = join(baselinesDir, "runs", `${mergeBase}.jsonl`);
    copyFileSync(cached, dest);
    console.log(`#1081 merge-base cache HIT: using runs/${mergeBase}.jsonl as baseline (${reason}).`);
    emitOutput("cache", "hit");
    emitOutput("baseline_path", dest);
    return;
  }

  // Miss: leave whatever the prior fetch step already placed at `dest`
  // (test262-current.jsonl). Warn so cache-miss frequency is trackable.
  console.log(
    `::warning::#1081 merge-base cache MISS (${reason}); falling back to latest-main baseline. Drift attribution may be imprecise for this PR.`,
  );
  emitOutput("cache", "miss");
  emitOutput("baseline_path", dest);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
