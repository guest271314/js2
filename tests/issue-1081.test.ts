// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1081 — commit-hash-indexed test262 run cache.
//
// Unit tests for the pure helpers that back the workflow steps:
//   - buildRunSummary / isCorrupt (write-run-cache.mjs)
//   - evaluateCacheEntry (resolve-merge-base-baseline.mjs)
//   - planEvictions (prune-run-cache.mjs)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunSummary, isCorrupt } from "../scripts/write-run-cache.mjs";
import { evaluateCacheEntry } from "../scripts/resolve-merge-base-baseline.mjs";
import { planEvictions } from "../scripts/prune-run-cache.mjs";

describe("#1081 write-run-cache buildRunSummary", () => {
  const report = {
    summary: { total: 43135, pass: 30214, fail: 11775, compile_error: 1124, compile_timeout: 4, skip: 18 },
    strict_summary: { pass: 9000, total: 12000 },
    categories: {
      "language/statements/for-of": { pass: 134, fail: 12, compile_error: 0, total: 146 },
      "built-ins/Array": { pass: 500, fail: 50, compile_error: 5, total: 555 },
    },
  };

  it("captures summary counts and metadata keyed by sha", () => {
    const s = buildRunSummary(report, {
      sha: "ef179253babc",
      ref: "refs/heads/main",
      runId: "24289351335",
      runStartedAt: "2026-04-11T17:55:12Z",
      runDurationSeconds: 320,
      test262Version: "63829c6d925e",
    });
    expect(s.sha).toBe("ef179253babc");
    expect(s.pass).toBe(30214);
    expect(s.total).toBe(43135);
    expect(s.compile_error).toBe(1124);
    expect(s.strict_pass).toBe(9000);
    expect(s.run_id).toBe("24289351335");
    expect(s.test262_version).toBe("63829c6d925e");
  });

  it("persists a per-category breakdown for fast diffs", () => {
    const s = buildRunSummary(report, { sha: "abc1234" });
    expect(s.categories["language/statements/for-of"]).toEqual({
      pass: 134,
      fail: 12,
      compile_error: 0,
      total: 146,
    });
  });

  it("flags corrupt reports below the sanity floor", () => {
    expect(isCorrupt(buildRunSummary({ summary: { pass: 10, total: 100 } }, { sha: "x" }))).toBe(true);
    expect(isCorrupt(buildRunSummary(report, { sha: "x" }))).toBe(false);
  });
});

describe("#1081 resolve-merge-base-baseline evaluateCacheEntry", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rc-"));
    mkdirSync(join(dir, "runs"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const sha = "deadbeef1234";

  function writeEntry(test262Version?: string) {
    writeFileSync(join(dir, "runs", `${sha}.jsonl`), '{"test":"a","result":"pass"}\n');
    writeFileSync(
      join(dir, "runs", `${sha}.json`),
      JSON.stringify({ sha, pass: 30000, total: 43000, test262_version: test262Version ?? null }),
    );
  }

  it("HIT when the merge-base entry exists and versions match", () => {
    writeEntry("v262");
    expect(evaluateCacheEntry(dir, sha, "v262")).toEqual({
      hit: true,
      reason: expect.stringContaining("present"),
    });
  });

  it("MISS when no entry exists for the merge-base", () => {
    expect(evaluateCacheEntry(dir, "nonexistent", "v262").hit).toBe(false);
  });

  it("MISS when the cached test262_version differs from current", () => {
    writeEntry("v261");
    const r = evaluateCacheEntry(dir, sha, "v262");
    expect(r.hit).toBe(false);
    expect(r.reason).toContain("test262_version");
  });

  it("HIT when no version is supplied (version guard is opt-in)", () => {
    writeEntry("v261");
    expect(evaluateCacheEntry(dir, sha, "").hit).toBe(true);
  });
});

describe("#1081 prune-run-cache planEvictions", () => {
  const now = Date.parse("2026-06-03T00:00:00Z");
  const daysAgo = (n: number) => now - n * 24 * 60 * 60 * 1000;
  const MB = 1024 * 1024;

  it("evicts entries older than max-age but keeps recent ones", () => {
    const entries = [
      { sha: "recent", bytes: 1 * MB, mtimeMs: daysAgo(5) },
      { sha: "old", bytes: 1 * MB, mtimeMs: daysAgo(40) },
    ];
    const evict = planEvictions(entries, { now, maxAgeDays: 30, maxBytes: 500 * MB });
    expect(evict).toEqual(["old"]);
  });

  it("never evicts sprint-tagged shas even when old", () => {
    const entries = [{ sha: "sprintcommit", bytes: 1 * MB, mtimeMs: daysAgo(400) }];
    const evict = planEvictions(entries, { now, maxAgeDays: 30, keepShas: ["sprintcommit"] });
    expect(evict).toEqual([]);
  });

  it("LRU-evicts oldest survivors when over the byte cap", () => {
    const entries = [
      { sha: "a", bytes: 200 * MB, mtimeMs: daysAgo(3) },
      { sha: "b", bytes: 200 * MB, mtimeMs: daysAgo(2) },
      { sha: "c", bytes: 200 * MB, mtimeMs: daysAgo(1) },
    ];
    // 600 MB total, cap 500 MB → oldest ("a") evicted to get under.
    const evict = planEvictions(entries, { now, maxAgeDays: 30, maxBytes: 500 * MB });
    expect(evict).toEqual(["a"]);
  });

  it("keeps sprint-tagged shas even under cap pressure", () => {
    const entries = [
      { sha: "sprint", bytes: 400 * MB, mtimeMs: daysAgo(10) },
      { sha: "newer", bytes: 200 * MB, mtimeMs: daysAgo(1) },
    ];
    // 600 MB, cap 500 MB. Oldest is the sprint commit but it is immune, so
    // the next-oldest non-pinned ("newer") is evicted instead.
    const evict = planEvictions(entries, { now, maxAgeDays: 30, maxBytes: 500 * MB, keepShas: ["sprint"] });
    expect(evict).toEqual(["newer"]);
  });
});
