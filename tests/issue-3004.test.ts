// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3004 — vacuity-reclassification gate excusal (**TEMPORARY, DEFAULT-ON**,
// removal follow-up #3001).
//
// #2463's vacuity scorer intentionally rescored ~1438 vacuous "passes" (the
// harness-wrapper callback never executed, so no assertion ran) as `fail`
// WITHOUT bumping the #2096 oracle_version. The HOST baseline was re-promoted to
// new-policy but the STANDALONE baseline was left stale old-policy, so every
// code PR's merge_group standalone diff reads the policy delta as a mass
// regression (the d822f85a −1438 cluster) and wedges the merge queue.
//
// `diff-test262.ts` excludes those pass→vacuous flips from the gated regression
// count **UNCONDITIONALLY (default-on)** — mirroring the #2167 stale-async flake
// exclusion, NOT the flag-gated leaky excusal. This is load-bearing for
// self-landing: `merge_group` runs the BASE-branch (main) workflow YAML against
// the MERGED-tree script, so a flag added only in a PR's YAML would not fire in
// that PR's own merge_group and the fixing PR would park itself (deadlock). A
// default-on, script-side exclusion fires in every merge_group regardless of
// which YAML runs. These tests pin the behaviour required by the incident fix:
//   1. a synthetic pass→vacuous-fail IS excused by DEFAULT (no flag needed);
//   2. a real pass→fail with a NON-vacuous reason still counts at full strength;
//   3. a genuine net-negative (non-vacuous) still fails the gate;
//   4. the excused-count line is always emitted (grep-able);
//   5. the workflow does NOT pass a vacuity flag (guards against re-introducing
//      the deadlock-prone flag design).

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

// Run the diff with NO extra flags — the vacuity exclusion is default-on, so the
// bare invocation is exactly what a merge_group runs (base-branch YAML has no
// vacuity flag).
function runDiff(baseline: unknown[], candidate: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "issue-3004-diff-"));
  try {
    const basePath = join(dir, "baseline.jsonl");
    const candPath = join(dir, "candidate.jsonl");
    writeJsonl(basePath, baseline);
    writeJsonl(candPath, candidate);
    return spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/diff-test262.ts", basePath, candPath, "--quiet"],
      { cwd: ROOT, encoding: "utf-8" },
    );
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

describe("#3004 — end-to-end gate behaviour (default-on, no flag)", () => {
  // A single pass→vacuous flip, with a CHANGED wasm_sha so it is NOT filtered
  // out by the #1222 wasm-identical noise path — proving the *vacuity excusal*
  // (not the noise filter) is what drops it, and that it fires with NO flag.
  const vacuousBaseline = [{ file: "vac.js", status: "pass", wasm_sha: "aaaaaaaaaaa1" }];
  const vacuousCandidate = [
    { file: "vac.js", status: "fail", vacuous: true, error: VACUOUS_ERROR, wasm_sha: "aaaaaaaaaaa2" },
  ];

  it("EXCUSES the vacuity flip BY DEFAULT (no flag): REG=0, excused=1, gate passes — the merge_group self-land property", () => {
    const r = runDiff(vacuousBaseline, vacuousCandidate);
    expect(r.stdout).toContain("=== Regressions with wasm-hash change: 0 ===");
    expect(r.stdout).toMatch(/Excused vacuous reclassifications[^\n]*: 1 ===/);
    expect(r.status).toBe(0); // net = 0 improvements − 0 regressions ⇒ not a net negative
  });

  it("excuses via the error-string fallback alone (row without the vacuous:true boolean)", () => {
    const r = runDiff(vacuousBaseline, [
      { file: "vac.js", status: "fail", error: VACUOUS_ERROR, wasm_sha: "aaaaaaaaaaa2" },
    ]);
    expect(r.stdout).toContain("=== Regressions with wasm-hash change: 0 ===");
    expect(r.stdout).toMatch(/Excused vacuous reclassifications[^\n]*: 1 ===/);
    expect(r.status).toBe(0);
  });

  it("does NOT excuse a real non-vacuous regression (default-on is narrow): REG=1, excused=0, gate fails", () => {
    const baseline = [{ file: "real.js", status: "pass", wasm_sha: "bbbbbbbbbbb1" }];
    const candidate = [{ file: "real.js", status: "fail", error: "AssertionError", wasm_sha: "bbbbbbbbbbb2" }];
    const r = runDiff(baseline, candidate);
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
    const r = runDiff(baseline, candidate);
    expect(r.stdout).toContain("=== Regressions with wasm-hash change: 1 ===");
    expect(r.stdout).toMatch(/Excused vacuous reclassifications[^\n]*: 1 ===/);
    expect(r.status).toBe(1);
  });

  it("always emits the grep-able excused-count line (even when zero)", () => {
    const r = runDiff(
      [{ file: "x.js", status: "pass", wasm_sha: "eeeeeeeeeee1" }],
      [{ file: "x.js", status: "pass", wasm_sha: "eeeeeeeeeee1" }],
    );
    expect(r.stdout).toContain("Excused vacuous reclassifications");
  });
});

describe("#3004 — merge_group self-land invariant", () => {
  it("the standalone guard does NOT pass a vacuity flag — the exclusion must be default-on in the script", () => {
    // A flag added only in this PR's YAML would NOT fire in the PR's own
    // merge_group (which runs the BASE-branch YAML), so the fix would deadlock.
    // The exclusion is therefore script-side/default-on; the workflow must stay
    // flag-free for vacuity. If this ever regresses to a flag, the wedge returns.
    const workflow = readFileSync(resolve(ROOT, ".github/workflows/test262-sharded.yml"), "utf-8");
    expect(workflow).not.toContain("--exclude-vacuous-reclassification");
    // The pre-existing leaky flag is unaffected.
    expect(workflow).toContain("--exclude-leaky-baseline-regressions");
  });
});
