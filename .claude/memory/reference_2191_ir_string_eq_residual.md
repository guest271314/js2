---
name: reference_2191_ir_string_eq_residual
description: "#2191 ROOT CAUSE (confirmed): NOT the IR string.eq/flatten — it was a late-import funcIdx-shift in #40's ascii→uni case-convert REPOINT; the === call site resolved to the un-patched ascii toUpperCase body. Fixed by name-based repoint (commit 7ae5c5df4)."
metadata:
  type: reference
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

**RESOLVED — confirmed root cause (2026-06-18, agent a0662021, commit
7ae5c5df4 on issue-40-string-residual).** Two earlier hypotheses were BOTH
wrong and are superseded; recorded here so they aren't re-tried:
- WRONG #1 (mine): "IR string.eq lowering needs flatten-both / the ≥0x80
  i16 array-rep differs." `__str_equals` ALREADY flattens both operands
  internally — pre-flattening at lower.ts is a no-op.
- WRONG #2 (sdev-proxy3): "IR string.eq feeds wrong operands / negate flag."
  Also not it — the comparison was correct all along.

**ACTUAL root cause — a late-import funcIdx-shift in MY #40 code:** the
ascii→uni `toUpperCase`/`toLowerCase` REPOINT in
`src/codegen/case-convert-native.ts` (~line 567) copied `uniFn.body` into the
ascii fn via `ctx.mod.functions[asciiIdx - ctx.numImportFuncs]`. But `asciiIdx`
was captured (in `nativeStrHelpers`) BEFORE a late import grew
`numImportFuncs` between registration and repoint — so the computed slot
pointed at a DIFFERENT function, leaving the real ascii `$__str_toUpperCase`
(à=0xE0 ∉ [a-z], so unchanged) un-patched. The `===` call site resolved to
that un-patched ascii body (returns "à"=0xE0) while `charCodeAt` resolved to
the uni body (returns "À"=0xC0). So `__str_equals` was correctly comparing
0xE0 ≠ 0xC0 → 0.

**Decisive disproof of the comparison theory:** `"à".toUpperCase() === "à"`
(vs the LOWERCASE input) returns TRUE ⇒ the `===`-path toUpperCase output is
still "à", i.e. never uppercased. The bug is wrong-FUNCTION-dispatch, not
byte-comparison.

**Fix:** re-point the PUBLIC `__str_toUpperCase`/`__str_toLowerCase` NAMES in
`nativeStrHelpers` + `funcMap` to the `_uni` funcIdx (name/funcMap-based,
shift-IMMUNE); the ascii body becomes dead code. tests/issue-2191-case-equals.test.ts
6/6 green; #40 case suite 18/18 green.

**STATUS: already ON upstream/main — nothing to land.** Verified in git
(2026-06-18): `git merge-base --is-ancestor 7ae5c5df4 upstream/main` → YES;
`tests/issue-2191-case-equals.test.ts` exists on upstream/main;
`upstream/main..origin/issue-40-string-residual` is EMPTY. The fix shipped
inside MERGED PR #1676 (title "fix(#40): … (+#2191 helper re-point)"). The
issue-40-string-residual branch is just stale doc commits on top of an
already-merged fix — do NOT open a PR for it (would burn the full CI matrix
on duplicate work). I briefly mis-flagged this as a "stranded fix needing a
PR"; the coordinator's git verification corrected it. Lesson: verify
landed-ness in git (`merge-base --is-ancestor` + file-on-main) BEFORE
escalating a branch as orphaned — a branch having commits ≠ those commits
being un-merged.

**General lesson (reinforces [[reference_no_rebuild_helper_body_at_finalize]]):**
NEVER index `ctx.mod.functions[idx - ctx.numImportFuncs]` with an `idx`
captured before a later phase that can add imports — `numImportFuncs` shifts.
Repoint/patch a helper by NAME via funcMap (shift-immune), not by a
pre-captured numeric funcIdx. Two call sites silently resolving to two
different bodies of the "same" helper is the tell.
