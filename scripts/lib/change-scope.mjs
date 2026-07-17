// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// scripts/lib/change-scope.mjs — change-set scoping shared by the
// source-derived ratchet gates (#3131: check-loc-budget.mjs,
// check-coercion-sites.mjs).
//
// WHY THIS EXISTS
// ---------------
// The ratchet gates used to require every growing PR to commit a bump of a
// shared baseline JSON. Because the bump is a whole-tree snapshot, every merge
// to main re-conflicted every open PR's bump on that one file — the sole
// source of the loc-budget merge-conflict churn that held the #2835 stack
// (4 re-merges for a +12 LOC PR). This module lets the gates derive the
// change-set's OWN before/after state from git instead, so PRs never touch
// the committed baselines at all (main's post-merge refresh is the sole
// writer; see #3131).
//
// BASE RESOLUTION (exactness matters — there is no committed ceiling to mask
// an over-included diff anymore):
//   1. `LOC_GATE_BASE` env — explicit override (tests, emergencies).
//   2. CI merge parent: on `pull_request` / `merge_group` / `push` /
//      `workflow_dispatch` (#3344) events the
//      checked-out HEAD is a synthetic merge commit created by GitHub
//      (refs/pull/N/merge, the merge-queue group head, or the landed queue
//      merge) whose FIRST parent is always the base side. `HEAD^1` is
//      therefore the exact tree this change-set was built on — race-free even
//      when origin/main advances mid-run, and present at fetch-depth: 2.
//      NOTE: this is only sound for GitHub's synthetic refs (base parent
//      first). A dev's own "merge origin/main into branch" commit has the
//      OPPOSITE parent order, which is why this arm is gated on
//      GITHUB_ACTIONS + event name and never used locally.
//   3. `git merge-base origin/main HEAD` — the fork point. Exact locally:
//      diff(fork-point, working tree) is precisely the branch's own work
//      (merging origin/main into the branch advances the fork point too).
//   4. `origin/main` tree-diff — shallow-safe last resort; may over-include
//      if main moved between checkout and fetch.
//   5. undefined — no git at all; callers fall back to the committed
//      baseline (legacy whole-tree mode).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function git(repoRoot, argv) {
  return execFileSync("git", argv, {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function gitTry(repoRoot, argv) {
  try {
    return git(repoRoot, argv).trim();
  } catch {
    return undefined;
  }
}

/**
 * Resolve the change-set's diff base. Returns `{ base, how }` where `base`
 * is a committish (or undefined when not in a usable git worktree) and `how`
 * names the resolution arm for log lines.
 */
export function resolveChangeBase(repoRoot) {
  if (process.env.LOC_GATE_BASE) return { base: process.env.LOC_GATE_BASE, how: "env:LOC_GATE_BASE" };
  if (gitTry(repoRoot, ["rev-parse", "--is-inside-work-tree"]) !== "true") return { base: undefined, how: "no-git" };
  const ev = process.env.GITHUB_EVENT_NAME;
  if (
    process.env.GITHUB_ACTIONS === "true" &&
    (ev === "pull_request" || ev === "merge_group" || ev === "push" || ev === "workflow_dispatch")
  ) {
    // Synthetic-merge fast path (see header). Only when HEAD really is a
    // merge commit; a single-commit direct push falls through to merge-base.
    // `workflow_dispatch` (#3344) is included so an EMERGENCY manual retrigger
    // against a real merge-commit SHA reproduces the organic push scoping (the
    // PR's own change-set, incl. its regressions-allow declaration). The
    // HEAD^2 guard makes this backward-compatible: an ordinary branch-tip
    // dispatch has a single-parent HEAD, so it no-ops here and falls through
    // to the merge-base arm exactly as before.
    if (gitTry(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^2"])) {
      const p1 = gitTry(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^1"]);
      if (p1) return { base: p1, how: `ci-merge-parent(${ev})` };
    }
  }
  if (!gitTry(repoRoot, ["rev-parse", "--verify", "--quiet", "origin/main"]))
    return { base: undefined, how: "no-origin-main" };
  const mb = gitTry(repoRoot, ["merge-base", "origin/main", "HEAD"]);
  if (mb) return { base: mb, how: "merge-base" };
  return { base: "origin/main", how: "origin-main-tree" };
}

/**
 * Paths (repo-relative, forward-slash) changed between `base` and the WORKING
 * TREE under `prefix` — committed + uncommitted edits + deletions
 * (`--no-renames` keeps both sides of a move visible), plus untracked files
 * (so a brand-new not-yet-`git add`ed file gates locally the same way it will
 * in CI). Returns undefined when the diff itself fails (unknown base).
 */
export function changedPaths(repoRoot, base, prefix) {
  const diff = gitTry(repoRoot, ["diff", "--name-only", "--no-renames", base, "--", prefix]);
  if (diff === undefined) return undefined;
  const out = new Set();
  for (const line of diff.split("\n")) {
    const p = line.trim();
    if (p) out.add(p);
  }
  const untracked = gitTry(repoRoot, ["ls-files", "--others", "--exclude-standard", "--", prefix]);
  if (untracked) {
    for (const line of untracked.split("\n")) {
      const p = line.trim();
      if (p) out.add(p);
    }
  }
  return out;
}

/** Contents of `path` at `base`, or undefined if absent there. */
export function baseBlob(repoRoot, base, path) {
  try {
    return git(repoRoot, ["show", `${base}:${path}`]);
  } catch {
    return undefined;
  }
}

/**
 * The intentional-growth hatch (#3131). A change-set grants itself an
 * allowance by listing repo-relative paths under `<key>:` in the YAML
 * frontmatter of any `plan/issues/**.md` file the change-set itself adds or
 * modifies — i.e. the PR's own issue file:
 *
 *   loc-budget-allow:
 *     - src/codegen/expressions/calls.ts
 *
 * (inline `key: [a, b]` and single-scalar `key: a` forms also accepted).
 * Only issue files IN THE DIFF are consulted, so an old allowance on main
 * grants nothing to later PRs. Unique file per PR ⇒ no cross-PR conflicts —
 * this replaces the committed-baseline bump that caused the merge churn.
 *
 * Returns Map<allowedPath, grantingIssueFiles[]>.
 */
export function changeSetAllowances(repoRoot, base, key) {
  const allow = new Map();
  const changed = changedPaths(repoRoot, base, "plan/issues");
  if (!changed) return allow;
  for (const p of [...changed].sort()) {
    if (!p.endsWith(".md")) continue;
    const abs = join(repoRoot, p);
    if (!existsSync(abs)) continue; // deleted by this change-set
    let text;
    try {
      text = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    for (const item of parseFrontmatterList(text, key)) {
      if (!allow.has(item)) allow.set(item, []);
      allow.get(item).push(p);
    }
  }
  return allow;
}

/**
 * #3303 — numeric-ceiling counterpart of `changeSetAllowances` for gates whose
 * allowance is a single `count` + required `reason`, not a list of paths. A
 * change-set declares it under `<key>:` in the YAML frontmatter of any
 * `plan/issues/**.md` file the change-set itself adds or modifies:
 *
 *   regressions-allow:
 *     count: 2700
 *     reason: "#3285 assert_throws error-type tightening, see #3286"
 *
 * Same PR-scoping property as `changeSetAllowances`: only issue files IN THE
 * DIFF are consulted, so an allowance that landed on main grants nothing to
 * later PRs (a follow-up PR that re-touches a landed granting issue file
 * should strip the key). `reason` is REQUIRED — a bare number is not
 * self-documenting in review/blame, so a declaration missing either a
 * positive-integer `count` or a non-empty `reason` is reported in `invalid`
 * (callers warn loudly) and grants nothing.
 *
 * Returns { declarations: {count, reason, source}[], invalid: string[] }.
 */
export function changeSetNumericAllowances(repoRoot, base, key) {
  const out = { declarations: [], invalid: [] };
  const changed = changedPaths(repoRoot, base, "plan/issues");
  if (!changed) return out;
  for (const p of [...changed].sort()) {
    if (!p.endsWith(".md")) continue;
    const abs = join(repoRoot, p);
    if (!existsSync(abs)) continue; // deleted by this change-set
    let text;
    try {
      text = readFileSync(abs, "utf-8");
    } catch {
      continue;
    }
    const parsed = parseFrontmatterCountReason(text, key);
    if (parsed === undefined) continue; // key absent in this file
    if (parsed === null) {
      out.invalid.push(p); // key present but malformed — surface, don't grant
      continue;
    }
    out.declarations.push({ ...parsed, source: p });
  }
  return out;
}

/**
 * Minimal YAML-frontmatter reader for a `key:` block carrying nested `count:`
 * and `reason:` scalars (block form only — the shape documented on
 * `changeSetNumericAllowances`). Returns:
 *   - undefined        when `key:` is absent (no declaration at all),
 *   - null             when `key:` is present but malformed (missing/invalid
 *                      count or missing reason) — callers should warn loudly,
 *   - {count, reason}  for a valid declaration.
 */
export function parseFrontmatterCountReason(text, key) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return undefined;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(`${key}:`)) continue;
    let count;
    let reason;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s*$/.test(lines[j]) || /^\s*#/.test(lines[j])) continue; // blank / comment line inside the block
      const lm = lines[j].match(/^\s+([A-Za-z_-]+):\s*(.*)$/);
      if (!lm) break; // dedent / list item ⇒ end of the nested block
      const v = unquote(lm[2].trim());
      if (lm[1] === "count") count = /^[0-9]+$/.test(v) ? Number.parseInt(v, 10) : NaN;
      else if (lm[1] === "reason") reason = v;
    }
    const valid = Number.isInteger(count) && count > 0 && typeof reason === "string" && reason.length > 0;
    return valid ? { count, reason } : null;
  }
  return undefined;
}

function unquote(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

/** Minimal YAML-frontmatter list reader for `key:` (block, inline, scalar). */
export function parseFrontmatterList(text, key) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return [];
  const lines = m[1].split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith(`${key}:`)) continue;
    const rest = lines[i].slice(key.length + 1).trim();
    if (rest.startsWith("[")) {
      for (const it of rest.replace(/^\[/, "").replace(/\]$/, "").split(",")) {
        const v = unquote(it.trim());
        if (v) out.push(v);
      }
    } else if (rest) {
      out.push(unquote(rest));
    } else {
      for (let j = i + 1; j < lines.length; j++) {
        if (/^\s*$/.test(lines[j]) || /^\s*#/.test(lines[j])) continue; // blank / comment line inside the block
        const lm = lines[j].match(/^\s+-\s+(.+)$/);
        if (!lm) break;
        const v = unquote(lm[1].trim());
        if (v) out.push(v);
      }
    }
  }
  return out;
}
