---
id: 2168
title: "Cross-developer issue-assignment lock (humans + agents, no CI churn)"
status: in-progress
sprint: Backlog
created: 2026-06-15
updated: 2026-06-15
priority: high
feasibility: medium
reasoning_effort: medium
task_type: infrastructure
area: tooling
language_feature: n/a
goal: developer-experience
assignee: "ttraenkler/tech-lead"
---

## Problem

Multiple developers now work the project concurrently — humans **and** dev
agents, potentially across forks. The existing dispatch mechanisms (the
in-memory native TaskList and the Symphony MCP) are invisible to a human dev and
to anyone on a different machine/fork, so two developers can pick up the same
issue. We need a claim that is visible to *everyone* and survives across
processes: a git-backed lock.

Requirements (from the request):
1. Issues are assigned to a named developer. Agents use a github-account-prefixed
   name, e.g. `ttraenkler/<agent-name>`, so work is attributable to the pushing
   account.
2. When an issue is picked up, the dev first **syncs with `origin`** to confirm
   it's still unassigned.
3. The assignment is **pushed immediately** so other devs can't grab the same
   task — a true mutual-exclusion lock.
4. The assignment push must **not trigger CI for open PRs**, since it doesn't
   touch source code.

## Key constraint discovered

Requirement #4 is only half-solved by `[skip ci]`. `[skip ci]` (and the existing
`plan/**` path filter on `test262-sharded.yml`) suppress a push's *own* workflow
runs — but **any** push to `main`, even `[skip ci]`, makes GitHub **rebuild every
queued merge group** (full 114-job validation per queued PR + ~10 min latency
each). This is documented in `baseline-summary-sync.yml` / #1951. So committing
the live lock to `main` would churn the merge queue precisely when devs are busy.

## Design

The **live lock** lives on a dedicated orphan ref, `refs/heads/issue-assignments`
on `origin` — one `<id>.json` per claimed issue (`{id, assignee, status, branch,
claimed_at, ...}`). Pushing there:
- does not move `main` → never rebuilds merge groups, never triggers CI;
- is git-atomic: first `git push` wins; a concurrent claimant gets a
  non-fast-forward rejection, re-fetches, and re-evaluates (retry loop).

The issue file's `assignee` frontmatter on `main` is **eventually-consistent** —
written lazily inside the issue's own implementation PR (alongside `status:
in-progress`), so it reflects on `main` when that PR merges. The ref is the
authoritative "who holds this now" lock; the frontmatter is the durable record.

## Implementation (this issue)

- `scripts/claim-issue.mjs` — pure git-plumbing (`hash-object` / `update-index` /
  `write-tree` / `commit-tree` / `push`), never mutates the working tree. Modes:
  `claim` (default), `--check`, `--list`, `--release`, `--complete`, `--force`.
  Pre-flight refuses claiming an issue already `done`/`wont-fix` on `origin/main`.
  Exit codes: `0` ok · `2` usage · `3` claimed by another · `4` closed on main ·
  `5` push gave up. Agent-name prefixing via `CLAIM_GITHUB_ACCOUNT` or a name
  already containing `/`.
- `.claude/skills/claim-issue.md` — `/claim-issue` wrapper + exit-code playbook.
- `plan/issues/SCHEMA.md` — new optional `assignee` field + the lock semantics.
- `.claude/agents/developer.md` / `senior-developer.md` — claim on Start, set
  `assignee`+`status` on the branch, `--release` on suspend, `--complete` on merge.

## Bootstrap

The `issue-assignments` ref does not exist yet on `origin`; the first
`claim-issue.mjs` claim creates it (commit-tree with no parent → push). No manual
bootstrap step is required. Verified end-to-end against a local throwaway remote
(claim / double-claim-reject / list / done-refuse / release / re-claim / agent
prefix / `--force` steal).

## Acceptance criteria

- [x] A dev can claim an issue with one command; a second dev claiming the same
      issue is rejected (exit 3).
- [x] Claiming refuses an issue already closed on `main` (exit 4).
- [x] The claim push goes to a non-`main` ref → no CI run, no merge-queue rebuild.
- [x] Agent names are github-account-prefixed.
- [x] developer/senior-developer protocols + schema document the flow.
- [ ] First real claim against `origin` bootstraps the ref (pending first use).
