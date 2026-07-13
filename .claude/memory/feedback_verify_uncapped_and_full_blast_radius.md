---
name: feedback_verify_uncapped_and_full_blast_radius
description: "A second confirmed-false \"0 regressions\" self-report this session (PR"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

2026-07-03: PR #2570 (issue #3010, standalone destructuring container-guard fix) was self-reported "verified status-identical to clean baseline, 0 regressions" — but the merge_group re-validation failed deterministically (net −19, 24 real regressions). A dedicated ground-truth investigation (compiling+running the actual test files on plain main vs main+PR, bypassing any committed baseline) confirmed: the fix genuinely broke 24 files in a DIFFERENT test cluster (`*ary-ptrn-empty`, empty-destructuring-pattern) than the one it was designed to fix and had verified (`*elem-id-init`). The author's verification never ran the cluster their own code change touched, because their fix's blast radius (gating a whole helper block including its `ensureLateImport`/`flushLateImportShifts` side effects) was wider than the specific bug they were targeting.

This is the SECOND time this exact session a plausible, technically-detailed self-report was independently disproven — the first was [[project_2463_vacuity_selfreport_disproven_by_independent_verify]] (a −1,433 vacuity reclassification PR, off by 1,056+ in the opposite direction of its self-claim). Both share the same root shape: the report isn't lying, it's **incomplete** — the author tested the cluster they intended to fix, not the full blast radius of the actual code change.

**Why this recurs:** any fix that touches shared/helper code (a gated block, a shared coercion path, a common dispatcher) has a blast radius potentially LARGER than the specific bug being targeted. "I verified my target cluster passes" is not the same claim as "I verified nothing else broke" — and self-reports systematically conflate the two, because the author's attention is anchored on the bug they're solving.

**How to apply:** for any fix to shared/gated/common code — especially one that changes WHICH code path executes for a whole class of inputs (a `standalone`/`host` gate, a shape/type dispatch, an import-registration conditional) — do not accept "0 regressions" from the author's own verification alone, no matter how detailed or technically fluent the report is. Before trusting a "clean" self-report on this class of change:
1. Identify the actual code touched and ask: what OTHER behavior does this same code path serve, beyond the target bug?
2. Independently re-derive via ground-truth measurement (compile+run the real test suite on both states, not a diff against a possibly-stale committed baseline) — see [[reference_intentional_negative_baseline_strands_inflight_queue_prs]] for why committed baselines can themselves be stale/wrong during a busy window.
3. Specifically probe adjacent/sibling clusters to the one the fix targets, not just the target cluster itself.

This is the same discipline already established for [[project_hostfree_pass_can_be_vacuous_inject_throw_probe]] and [[project_hostfree_pass_can_be_coincidentally_wrong_not_just_vacuous]] — never trust "it compiles/passes" as proof of "it's correct and nothing else broke." Independent verification is not bureaucratic overhead here; it has now caught two would-be-merged regressions in one session that would otherwise have shipped silently.
