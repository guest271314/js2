// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3004 — vacuity-reclassification gate excusal (**TEMPORARY**, removal
// follow-up #3001).
//
// #2463's vacuity scorer intentionally rescored ~1438 vacuous "passes" (the
// harness-wrapper callback never executed, so no assertion ran) as `fail`
// WITHOUT bumping the #2096 oracle_version. The HOST baseline was re-promoted to
// new-policy but the STANDALONE baseline was left stale old-policy, so every
// code PR's merge_group standalone diff reads the policy delta as a mass
// regression (the d822f85a −1438 cluster) and wedges the merge queue.
//
// `diff-test262.ts --exclude-vacuous-reclassification` drops those pass→vacuous
// flips out of the gated regression count so the queue clears. These tests pin
// the behaviour required by the incident fix:
//   1. a synthetic pass→vacuous-fail IS excused (dropped from REG) under the flag;
//   2. a real pass→fail with a NON-vacuous reason still counts at full strength;
//   3. a genuine net-negative (non-vacuous) still fails the gate;
//   4. without the flag, the vacuity flip counts (the excusal is opt-in);
//   5. the standalone guard (#1897) wires the flag in the workflow.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { isVacuousReclassification, isVacuousResult } from "../scripts/diff-test262.js";

const ROOT = resolve(import.meta.dirname ?? ".", "..");

const VACUOUS_ERROR = "vacuous: harness-wrapper callback never executed (#2940) — no assertion ran";

function writeJsonl(path: string, entries: unknown[]) {
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

function runDiff(baseline: unknown[], candidate: unknown[], extraArgs: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "issue-3004-diff-"));
  try {
    const basePath = join(dir, "baseline.jsonl");
    const candPath = join(dir, "candidate.jsonl");
    writeJsonl(basePath, baseline);
    writeJsonl(candPath, candidate);
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/diff-test262.ts", basePath, candPath, "--quiet", ...extraArgs],
      { cwd: ROOT, encoding: "utf-8" },
    );
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#3004 — isVacuousResult", () => {
  it("detects the explicit vacuous:true boolean", () => {
    expect(isVacuousResult({ vacuous: true })).toBe(true);
  });

  it("detects the canonical vacuous: error string as a fallback", () => {
    expect(isVacuousResult({ error: VACUOUS_ERROR })).toBe(true);
    expect(isVacuousResult({ error: "vacuous: anything else" })).toBe(true);
  });

  it("does NOT flag a non-vacuous fail", () => {
    expect(isVacuousResult({ error: "AssertionError: expected 1" })).toBe(false);
    expect(isVacuousResult({})).toBe(false);
    expect(isVacuousResult(undefined)).toBe(false);
    // A row that merely mentions "vacuous" mid-string is not a marker.
    expect(isVacuousResult({ error: "not vacuous: false alarm" })).toBe(false);
  });
});

describe("#3004 — isVacuousReclassification (both directions)", () => {
  it("EXCUSES a pass → vacuous fail (the #2463 policy delta)", () => {
    const base = { file: "t.js", status: "pass" };
    const cur = { file: "t.js", status: "fail", vacuous: true, error: VACUOUS_ERROR };
    expect(isVacuousReclassification(base, cur)).toBe(true);
  });

  it("EXCUSES via the error-string fallback when the boolean is absent", () => {
    const base = { file: "t.js", status: "pass" };
    const cur = { file: "t.js", status: "fail", error: VACUOUS_ERROR };
    expect(isVacuousReclassification(base, cur)).toBe(true);
  });

  it("DOES NOT excuse a pass → non-vacuous fail (real regression, full strength)", () => {
    const base = { file: "t.js", status: "pass" };
    const cur = { file: "t.js", status: "fail", error: "AssertionError" };
    expect(isVacuousReclassification(base, cur)).toBe(false);
  });

  it("DOES NOT excuse when the baseline was not a pass", () => {
    const base = { file: "t.js", status: "fail" };
    const cur = { file: "t.js", status: "fail", vacuous: true };
    expect(isVacuousReclassification(base, cur)).toBe(false);
  });
});

describe("#3004 — end-to-end gate behaviour (diff-test262 --exclude-vacuous-reclassification)", () => {
  // A single pass→vacuous flip, with a CHANGED wasm_sha so it is NOT filtered
  // out by the #1222 wasm-identical noise path — proving the *excusal* (not the
  // noise filter) is what drops it.
  const vacuousBaseline = [{ file: "vac.js", status: "pass", wasm_sha: "aaaaaaaaaaa1" }];
  const vacuousCandidate = [
    { file: "vac.js", status: "fail", vacuous: true, error: VACUOUS_ERROR, wasm_sha: "aaaaaaaaaaa2" },
  ];

  it("EXCUSES the vacuity flip under the flag: REG=0, excused=1, gate passes", () => {
    const r = runDiff(vacuousBaseline, vacuousCandidate, ["--exclude-vacuous-reclassification"]);
    expect(r.stdout).toContain("=== Regressions with wasm-hash change: 0 ===");
    expect(r.stdout).toMatch(/Excused vacuous reclassifications[^\n]*: 1 ===/);
    expect(r.status).toBe(0); // net = 0 improvements − 0 regressions ⇒ not a net negative
  });

  it("COUNTS the vacuity flip WITHOUT the flag (excusal is opt-in): REG=1, gate fails", () => {
    const r = runDiff(vacuousBaseline, vacuousCandidate, []);
    expect(r.stdout).toContain("=== Regressions with wasm-hash change: 1 ===");
    expect(r.stdout).not.toContain("Excused vacuous reclassifications");
    expect(r.status).toBe(1); // net = 0 − 1 < 0 ⇒ GATE FAIL
  });

  it("does NOT excuse a real non-vacuous regression even with the flag set: REG=1, excused=0, gate fails", () => {
    const baseline = [{ file: "real.js", status: "pass", wasm_sha: "bbbbbbbbbbb1" }];
    const candidate = [{ file: "real.js", status: "fail", error: "AssertionError", wasm_sha: "bbbbbbbbbbb2" }];
    const r = runDiff(baseline, candidate, ["--exclude-vacuous-reclassification"]);
    expect(r.stdout).toContain("=== Regressions with wasm-hash change: 1 ===");
    expect(r.stdout).toMatch(/Excused vacuous reclassifications[^\n]*: 0 ===/);
    expect(r.status).toBe(1);
  });

  it("a genuine net-negative still fails while the vacuity flip alongside is excused", () => {
    // vac.js (excused) + real.js (counts) ⇒ REG=1, net=−1, GATE FAIL. The
    // excusal is narrow: it never rescues a real regression riding alongside.
    const baseline = [
      { file: "vac.js", status: "pass", wasm_sha: "aaaaaaaaaaa1" },
      { file: "real.js", status: "pass", wasm_sha: "bbbbbbbbbbb1" },
    ];
    const candidate = [
      { file: "vac.js", status: "fail", vacuous: true, error: VACUOUS_ERROR, wasm_sha: "aaaaaaaaaaa2" },
      { file: "real.js", status: "fail", error: "AssertionError", wasm_sha: "bbbbbbbbbbb2" },
    ];
    const r = runDiff(baseline, candidate, ["--exclude-vacuous-reclassification"]);
    expect(r.stdout).toContain("=== Regressions with wasm-hash change: 1 ===");
    expect(r.stdout).toMatch(/Excused vacuous reclassifications[^\n]*: 1 ===/);
    expect(r.status).toBe(1);
  });
});

describe("#3004 — workflow wiring", () => {
  it("the standalone regression guard (#1897) passes --exclude-vacuous-reclassification", () => {
    const workflow = readFileSync(resolve(ROOT, ".github/workflows/test262-sharded.yml"), "utf-8");
    const start = workflow.indexOf("- name: Standalone regression guard (#1897)");
    const end = workflow.indexOf("- name: Compile-time regression guard (#1942)", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const guard = workflow.slice(start, end);
    expect(guard).toContain("--exclude-vacuous-reclassification");
    // still keeps the pre-existing leaky excusal
    expect(guard).toContain("--exclude-leaky-baseline-regressions");
  });
});
