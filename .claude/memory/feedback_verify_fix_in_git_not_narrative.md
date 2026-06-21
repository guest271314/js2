---
name: feedback_verify_fix_in_git_not_narrative
description: "When two sessions disagree on whether/how an issue is fixed, verify against actual upstream git history (commit ancestry + dedicated test presence), not either session's narrative or a stale worktree repro"
metadata:
  type: feedback
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

When peers (or you) disagree on whether an issue is fixed or what its root
cause is, **resolve it against the actual upstream git history, not anyone's
narrative.** Two objective checks settle it fast:
1. `git merge-base --is-ancestor <sha> upstream/main` — is the claimed fix
   commit actually on main?
2. `git ls-tree upstream/main -- tests/<dedicated-test>` — does the
   regression test exist on main?

**Sprint 63 #2191 case study (2026-06-18):** I'd told a teammate
(sdev-proxy3) the ≥0x80 `toUpperCase() === "À"` FAIL was an IR `string.eq`
operand/negate-flag bug, and they'd built a sharp "bytes are byte-identical
(indexOf/includes find it) so === is mis-comparing equal strings" repro on a
**stale worktree**. A general-purpose peer pushed back: already fixed on
upstream by commit `7ae5c5df4`, root cause = #40 **helper-routing**, not the
IR path. I verified independently: `7ae5c5df4` ("re-point
__str_toUpperCase/toLowerCase names to _uni — was: ascii body un-patched")
IS an ancestor of upstream/main and `tests/issue-2191-case-equals.test.ts`
exists there. The peer was right; my steer was the wrong layer.

**The actual bug + the red herring** (worth remembering as a class):
- The module emitted TWO helpers: ASCII-only `$__str_toUpperCase`
  (à=0xE0 ∉ [a-z] → returns input UNCHANGED) and `$__str_toUpperCase_uni`
  (à→À=0xC0). #1676's ascii→uni re-point used a **funcIdx-SHIFT-sensitive
  index** and missed the body the `===` call site resolved to.
- So `===` read the un-patched ascii helper (still "à", 0xE0) while
  `.charCodeAt`/`.indexOf` resolved to the `_uni` body (0xC0). The "bytes
  identical, indexOf finds it" evidence was a **red herring** — different
  funcIdx resolutions were reading **different strings**. `===` was
  correctly comparing "à" vs "À" (genuinely unequal). The IR string.eq
  lowering and negate flag were both fine.
- Fix (shift-immune): re-point the PUBLIC `__str_toUpperCase`/`__str_toLowerCase`
  NAMES (nativeStrHelpers + funcMap) directly at the `_uni` funcIdx.

**Compounding traps that made this confusing:**
- A multi-PR fix: task #45 was marked `completed` and #1676 merged, but the
  REAL close landed in a LATER commit (`7ae5c5df4`). "Task completed" +
  "a PR merged" ≠ "the bug is gone" — confirm the specific repro on
  upstream HEAD.
- A **stale worktree** repro looked live because it predated the real fix.
  Always rebase onto upstream/main before trusting a repro (ties to
  [[feedback_no_duplicate_issue_dispatch]]).
- Two sessions giving a teammate opposite root causes. Don't escalate the
  narrative war — drop to git ground truth.

**How to apply:** before steering a teammate on a fix's root cause, or
accepting/rejecting a peer's "it's already fixed" claim, run the two git
checks above. If the fix commit is an ancestor of upstream/main and the
dedicated test is present, it's fixed — retract any contrary steer
immediately so the teammate doesn't re-debug a closed issue. A confident
mechanistic story (mine OR a peer's) is not evidence; ancestry + test
presence is.
