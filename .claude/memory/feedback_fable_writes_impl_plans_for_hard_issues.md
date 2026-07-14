---
name: feedback_fable_writes_impl_plans_for_hard_issues
description: "Standing directive (2026-07-12): spend the abundant fable budget having a fable ARCHITECT write concrete `## Implementation Plan` specs into the issue files for the DIFFICULT issues — deep-compiler / architectural / broad-impact ones that opus (or any dev) may not crack alone without a written design first. De-risk the hard stuff with specs, don't just attempt it."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

**User directive (2026-07-12, during the fable burn):** "Make sure a fable
agent writes down an implementation plan for difficult issues that opus may not
be able to do alone."

**Why:** the fable weekly budget is plentiful and being burned hard; its
highest-leverage use for the HARDEST issues is not fable attempting them
directly (fable may not crack a broad-impact/architectural one), but a fable
**architect** producing architect-grade `## Implementation Plan` sections —
concrete functions, file:line anchors, Wasm/IR patterns, edge cases, spec
citations, bounded slicing, and CI/validation strategy — so those issues become
tractable for whoever implements them later (opus in the sprint loop, or a
fresh fable dev). Specs de-risk; a naive attempt on broad-impact codegen just
parks in merge_group.

**How to apply:** keep (at least intermittently) a fable **architect** subagent
(`subagent_type: architect`, `model: fable`, one-shot: read source → write
plans → PR the plan additions → exit) working the difficult backlog. Target set
= `[ARCH]`-tagged, `feasibility: hard`, broad-impact (value-rep / dispatch /
scorer-adjacent), or repeatedly-parked issues that LACK an existing
`## Implementation Plan`. EXCLUDE the aspirational goal-epics (compile
React/axios/tsc-itself, TS7 rewrite, big demos) — those are long-horizon goals,
not sprint-actionable. First concrete target this session: **#2997** (try→
try_table Wasm EH opcode migration — explicitly "needs architect spec first").
The architect edits ONLY `plan/issues/*.md`, never src/. This is additive to
the [[project_bloat_reduction_week_of_2026_07_11]] burn — it runs alongside the
4 devs + shepherd, as a transient subagent (auto-cleanup), not a 5th standing
teammate. Related: the `/architect-spec` skill, [[feedback_verify_first_beats_architect_spec]]
(verify-on-current-main beats a stale spec — architect must ground specs against
CURRENT main, not narrative).
