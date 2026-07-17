// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3344 — CI-robustness for the baseline promote pipeline.
//
// Two surgical fixes, one PR:
//
//   (1) The promote job's git-over-SSH pushes (baselines repo + main summary)
//       carry a step-level `timeout-minutes` so a hung push fails FAST and is
//       retriable, instead of consuming the whole job budget (the 2026-07-17
//       promote stranded ~2.5h this way, blocking the honest oracle-v7
//       baseline from publishing).
//
//   (2) `resolveChangeBase` (scripts/lib/change-scope.mjs) now includes
//       `workflow_dispatch` in the synthetic-merge-parent whitelist, so an
//       EMERGENCY manual retrigger against a real merge-commit SHA reproduces
//       the organic push scoping (the PR's own change-set, incl. its
//       `regressions-allow:` declaration). The HEAD^2 guard keeps it
//       backward-compatible: an ordinary branch-tip dispatch (single-parent
//       HEAD) still falls through to the merge-base arm.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveChangeBase } from "../scripts/lib/change-scope.mjs";

const ROOT = resolve(import.meta.dirname ?? ".", "..");

// ---------------------------------------------------------------------------
// (2) resolveChangeBase — workflow_dispatch synthetic-merge scoping
// ---------------------------------------------------------------------------

describe("#3344 — resolveChangeBase honors workflow_dispatch on a real merge commit", () => {
  let repo: string;
  const saved: Record<string, string | undefined> = {};

  function git(...args: string[]): string {
    const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
      cwd: repo,
      encoding: "utf-8",
    });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
    return (r.stdout ?? "").trim();
  }

  beforeEach(() => {
    for (const k of ["GITHUB_ACTIONS", "GITHUB_EVENT_NAME", "LOC_GATE_BASE"]) saved[k] = process.env[k];
    // A stale LOC_GATE_BASE would short-circuit arm 1 — clear it for these tests.
    Reflect.deleteProperty(process.env, "LOC_GATE_BASE");
    repo = mkdtempSync(join(tmpdir(), "issue-3344-repo-"));
    // Base commit on `base` branch; `origin/main` ref points at it so the
    // merge-base fallback arm is reachable in the single-parent case.
    git("init", "-q", "-b", "base");
    git("commit", "--allow-empty", "-m", "base", "-q");
    const baseSha = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", baseSha);
    // Feature branch with one commit off base.
    git("checkout", "-q", "-b", "feature");
    git("commit", "--allow-empty", "-m", "feature work", "-q");
  });

  afterEach(() => {
    for (const k of ["GITHUB_ACTIONS", "GITHUB_EVENT_NAME", "LOC_GATE_BASE"]) {
      if (saved[k] === undefined) Reflect.deleteProperty(process.env, k);
      else process.env[k] = saved[k];
    }
    rmSync(repo, { recursive: true, force: true });
  });

  it("resolves the first parent of a 2-parent HEAD under workflow_dispatch", () => {
    // Synthetic merge commit: FIRST parent = base side (GitHub's convention).
    git("checkout", "-q", "base");
    const baseSha = git("rev-parse", "HEAD");
    git("merge", "--no-ff", "-m", "merge feature", "feature", "-q");
    expect(git("rev-parse", "--verify", "HEAD^2")).toBeTruthy(); // really 2-parent

    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_EVENT_NAME = "workflow_dispatch";
    const { base, how } = resolveChangeBase(repo);
    expect(how).toBe("ci-merge-parent(workflow_dispatch)");
    expect(base).toBe(baseSha); // HEAD^1
  });

  it("falls through to the merge-base arm for a single-parent tip under workflow_dispatch", () => {
    // HEAD = feature tip: single parent, so the HEAD^2 guard no-ops and the
    // resolver drops to the merge-base arm (unchanged from before the fix).
    process.env.GITHUB_ACTIONS = "true";
    process.env.GITHUB_EVENT_NAME = "workflow_dispatch";
    const { base, how } = resolveChangeBase(repo);
    expect(how).toBe("merge-base");
    expect(base).toBe(git("merge-base", "refs/remotes/origin/main", "HEAD"));
  });

  it("still resolves the merge parent under the pre-existing push/merge_group/pull_request events", () => {
    git("checkout", "-q", "base");
    const baseSha = git("rev-parse", "HEAD");
    git("merge", "--no-ff", "-m", "merge feature", "feature", "-q");
    process.env.GITHUB_ACTIONS = "true";
    for (const ev of ["push", "merge_group", "pull_request"]) {
      process.env.GITHUB_EVENT_NAME = ev;
      const { base, how } = resolveChangeBase(repo);
      expect(how).toBe(`ci-merge-parent(${ev})`);
      expect(base).toBe(baseSha);
    }
  });
});

// ---------------------------------------------------------------------------
// (1) promote-job push steps carry a step timeout
// ---------------------------------------------------------------------------

describe("#3344 — promote push steps are bounded by a step timeout", () => {
  const workflow = readFileSync(resolve(ROOT, ".github/workflows/test262-sharded.yml"), "utf-8");

  /** The block of YAML for the named step, up to the next `- name:` sibling. */
  function stepBlock(stepName: string): string {
    const lines = workflow.split("\n");
    const start = lines.findIndex((l) => l.trimStart().startsWith(`- name: ${stepName}`));
    expect(start, `step "${stepName}" not found`).toBeGreaterThanOrEqual(0);
    const indent = lines[start].length - lines[start].trimStart().length;
    let end = start + 1;
    for (; end < lines.length; end++) {
      const l = lines[end];
      if (l.trim() === "") continue;
      const ind = l.length - l.trimStart().length;
      if (ind <= indent && l.trimStart().startsWith("- name:")) break;
    }
    return lines.slice(start, end).join("\n");
  }

  it("bounds the baselines-repo push (the 2.5h hang class)", () => {
    expect(stepBlock("Push baseline artifacts to js2wasm-baselines repo")).toMatch(/timeout-minutes:\s*\d+/);
  });

  it("bounds the main-repo summary push (same hang class)", () => {
    expect(stepBlock("Commit refreshed summary JSON to main repo")).toMatch(/timeout-minutes:\s*\d+/);
  });
});
