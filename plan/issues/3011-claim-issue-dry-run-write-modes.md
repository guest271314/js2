---
id: 3011
title: claim-issue.mjs --dry-run does not short-circuit in claim/release/complete modes
status: done
completed: 2026-07-03
sprint: 69
priority: high
horizon: s
assignee: ttraenkler/dev-dryrun-fix
---

## Problem

`scripts/claim-issue.mjs`'s `--dry-run` flag was only honored inside
`doAllocate` (the `--allocate` path). For the plain **claim** mode — and for
`--release` / `--complete` — `writeMode()` never checked the flag, so an
invocation intended as a probe performed a **real** claim/push to the
`issue-assignments` ref. Two different agents hit this independently in one day:
they ran something like `node scripts/claim-issue.mjs <id> <name> --dry-run`
expecting a preview and accidentally claimed a live issue.

The flag position did not matter to _detection_ (`flags` is a
position-independent `Set` of all `--`-prefixed args), but detection never fed
into `writeMode`, which mutated regardless.

## Root cause

`--dry-run` was handled only at `doAllocate` (`scripts/claim-issue.mjs`), not in
`writeMode()` (the claim/release/complete write path). `writeMode` ran straight
into the `commitAndPush` retry loop.

## Fix

Added a `--dry-run` short-circuit at the top of `writeMode()`, _after_ the
read-only done/wont-fix pre-flight and _before_ the retry/push loop. It does a
read-only lookup of the current holder, prints a `(dry-run) would <kind> …`
preview, and returns without any commit or push. Because `flags` is a
position-independent `Set`, the guard fires no matter where `--dry-run` appears
in argv.

## Verification

Reproduced first (against an isolated throwaway bare repo via
`CLAIM_ASSIGN_REMOTE`, never the real ref): pre-fix,
`claim-issue.mjs 999001 tester --dry-run` actually pushed a claim to the ref.

Post-fix, against the same isolated remote:

| Invocation                              | ref entries after |
| --------------------------------------- | ----------------- |
| `999001 tester --dry-run` (flag last)   | 0 (untouched)     |
| `--dry-run 999002 tester` (flag first)  | 0 (untouched)     |
| `999003 --dry-run tester` (flag middle) | 0 (untouched)     |
| `--release 999004 tester --dry-run`     | 0 (untouched)     |
| `999005 tester` (real claim, control)   | 1 (pushed)        |

All dry-run orderings short-circuit before any mutation; the real claim path is
unchanged.
