---
id: 1660
title: "Replace placeholder cla-check with a real CLA signature/approval gate"
status: ready
sprint: Backlog
created: 2026-05-24
updated: 2026-05-24
priority: high
feasibility: medium
task_type: infrastructure
area: ci/legal/governance
related: [1530]
---

# Replace placeholder cla-check with a real CLA signature/approval gate

## Problem

`.github/workflows/cla-check.yml` is a no-op placeholder. It only echoes:

> "CLA enforcement placeholder. Replace this workflow with a real contributor
> signature or approval system."

and passes for everyone, recording nothing. So the green `cla-check` status is
meaningless: no contributor has *affirmatively* accepted the CLA, and there is
no audit trail of acceptance.

## Why it matters

`CLA.md` (Loopdive GmbH terms) grants an irrevocable, worldwide, perpetual,
sublicensable, **relicensing** license — the contribution can be used under the
Apache-2.0-with-LLVM-Exceptions community distribution *and* commercial /
proprietary partner licenses. But today that grant rests only on a constructive
"by contributing you agree" theory: there is no signature, no recorded
acceptance, and no evidence the contributor ever saw the terms. That is weak
ground for any future relicensing.

This was surfaced by guest271314's first external PR (#589): we cannot rely on
any recorded CLA acceptance from them, because the gate records nothing.

## Proposed

Implement a real gate. Either:

- **(a) CLA-assistant bot** — requires an explicit "I have read and agree to the
  CLA" comment from the PR author and records signatures in a tracked file
  (auditable signatures list), or
- **(b) DCO `Signed-off-by` enforcement** — a required check that every commit
  in a PR carries a `Signed-off-by:` trailer matching the author.

Make the chosen gate a **required** status check on `main` (branch protection;
see `scripts/enable-branch-protection.sh` / `docs/ci-policy.md`). Document the
contributor flow in `CONTRIBUTING.md`. Remove the placeholder workflow.

## Acceptance

- External PRs **cannot merge** without a recorded affirmative CLA acceptance
  (bot signature or DCO sign-off).
- Signatures / acceptances are **auditable** (tracked file or per-commit
  trailer, inspectable after the fact).
- `CONTRIBUTING.md` explains the contributor flow.
- The placeholder `cla-check.yml` workflow is removed (replaced by the real
  gate as a required check).

## Note (legal)

The relicensing question itself warrants legal review; this issue covers the
**technical / process gate** only.

## Related

- #1530 (WASI native-messaging host example) — guest271314's PR #589 is gated
  on this issue. See the **HOLD** note in #1530: do not merge PR #589 until
  guest has an affirmative CLA acceptance recorded.
