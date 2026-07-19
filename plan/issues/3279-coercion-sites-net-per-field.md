---
id: 3279
title: "Coercion-site drift gate: net-per-vocabulary — stop relocation-shift failures on god-file splits"
status: done
assignee: ttraenkler/senior-dev-coercion
sprint: 72
created: 2026-07-14
updated: 2026-07-19
completed: 2026-07-14
priority: high
horizon: m
feasibility: hard
model: opus
reasoning_effort: max
task_type: refactor
area: ci
language_feature: compiler-internals
goal: maintainability
related: [2108, 3131, 3070, 3273, 3076, 3102]
---

# #3279 — Coercion-site drift gate: net-per-vocabulary (like the #3070 oracle-ratchet rework)

## Problem

`scripts/check-coercion-sites.mjs` (the "Coercion-site drift gate #2108/#3131"
quality step) was change-scoped but **per-file**: for each changed non-sanctioned
`src/codegen(-linear)` file it compared the file's coercion-vocabulary count at
the base blob vs the working tree and failed if **any single file's** count grew.

When a **byte-identical god-file split** relocates coercion-vocabulary sites out
of the source file and into a NEW sibling module, that new file shows `0 → N`
and the gate FAILED — unless the PR added a per-issue `coercion-sites-allow`
entry for every new module it created. Every Wave-B split PR kept hitting this
(e.g. **#3076** relocated `__is_truthy` into a new module and tripped the gate).
It is a **relocation-shift false-positive treadmill** — exactly the class
Dev-Gate already fixed for the oracle-ratchet gate in **#3070/#3273**
(`scripts/check-oracle-ratchet.mjs`).

## Fix

Port the **net-per-field** comparison from `check-oracle-ratchet.mjs` (#3070)
into `check-coercion-sites.mjs`, keeping the coercion gate's own
vocabulary-counting logic. Instead of failing on any single changed file's
increase, the change-scoped path now computes the **NET delta per vocabulary
token, summed across all changed non-allowed `src/codegen` files** (Σ now − Σ
was per token) and fails only when some token's net grew:

- A verbatim relocation (new module `+N`, source file `−N`) nets to **0** for
  every token and **PASSES with NO allowance**.
- A genuinely-new hand-rolled coercion (a token gains a use with no offsetting
  removal) nets **> 0** and still **FAILS**.

### Design decision — net PER VOCABULARY TOKEN, not per grand total

The oracle-ratchet template nets **per counted field** (`getTypeAtLocation`,
`ctx.checker`) so that removing one kind of debt cannot mask adding a different
kind. The faithful mirror here treats **each of the 17 sealed vocabulary tokens
as a "field"** and nets each independently. This is both the literal reading of
"net-per-field (a.k.a. net-per-vocabulary)" and strictly the safer choice:

- **Byte-identical relocations** (the entire Wave-B split pattern, incl. #3076)
  move every token verbatim, so each token nets 0 → they pass identically under
  per-token or per-total netting. The lead's goal — "eliminate the recurring
  relocation failures for all remaining Wave-B split PRs" — is fully met.
- **Per-token is stricter on the rare token-swap case**: removing a `__is_truthy`
  while adding a NEW `__any_to_string` in the same change-set is net-0 by grand
  total but introduces a genuinely-new hand-rolled ToString site. Per-token
  correctly fails it (the new-kind token nets +1); per-total would mask it. This
  preserves the gate's stated purpose — "a new hand-rolled site fails CI". A
  legitimate token-swap migration remains grantable via the existing
  `coercion-sites-allow` hatch.

### Preserved / added

- The per-issue `coercion-sites-allow:` frontmatter hatch is still honored;
  allowance-granted files are now **excluded from the net entirely** (they
  neither fault nor offset), matching the oracle-ratchet semantics.
- `--update` (post-merge/main writer) and `--update-on-decrease` (banking) are
  unchanged.
- The legacy whole-tree comparison against the committed baseline is preserved
  as the **no-git fallback** and is now also reachable via an explicit **`--all`**
  whole-tree audit (added for parity with oracle-ratchet's `--all`).
- The committed baseline is still refreshed post-merge on `main` only; PRs must
  not commit changes to it.

## Validation

Every direction was exercised end-to-end through the real gate binary against a
controlled git base (isolated fake repo whose layout mirrors the script's
`REPO_ROOT`; harness in `.tmp/validate-coercion-gate.sh`):

| Case | Scenario | Expected | Result |
| ---- | -------- | -------- | ------ |
| A  | genuinely-new `__any_to_string`, no allowance | FAIL (exit 1) | FAIL ✓ |
| A2 | same + `coercion-sites-allow` for the file | PASS (exit 0) | PASS ✓ |
| B  | net-0 relocation (source −3, NEW module +3) — **reproduces #3076** | PASS, no allowance | PASS ✓ |
| B2 | split that adds ONE extra `__is_truthy` site | FAIL (exit 1) | FAIL ✓ |
| B3 | net-0 grand total but token-swap (−`__is_truthy`, +`__any_to_string`) | FAIL (exit 1) | FAIL ✓ |
| C  | no working-tree change | PASS (exit 0) | PASS ✓ |

Also verified: the real gate passes on this PR's own worktree (0 changed
codegen files → net gate OK), the no-git/legacy fallback still compares against
the committed baseline, and `--all` performs a whole-tree audit (which surfaces
pre-existing committed-baseline staleness from already-merged split PRs — the
very drift the change-scoped net path is immune to; `--all` is opt-in and never
run in PR CI).

## Impact

Eliminates the recurring coercion-sites relocation failures for all remaining
Wave-B split PRs. CI's `Coercion-site drift gate` step (`pnpm run
check:coercion-sites`, default change-scoped mode) is the sole PR invocation and
now nets per vocabulary token; `--all` is opt-in only.
