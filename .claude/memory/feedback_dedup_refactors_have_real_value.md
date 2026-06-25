---
name: feedback_dedup_refactors_have_real_value
description: Don't park behavior-neutral dedup / single-engine refactors for "zero test262 payload" — eliminating divergent copies is the goal
metadata:
  type: feedback
  originSessionId: 54c1df0f
---

**Corrected 2026-06-22 (s65).** I parked #1917 (the "one coercion engine" — fold ~4 divergent hand-rolled ToString/ToNumber/ToBoolean/equality matrices into one) on the reasoning: all its named bugs were already fixed per-site, the #2108 drift gate already prevents NEW copies, and a behavior-neutral rewrite of the hottest paths has ZERO test262 payload at real regression risk → "wrong trade for a stability sprint." **The user disagreed and was right.**

**Why the park was wrong:**
- The #2108 gate only **freezes** the duplication; it does **not remove** it. With N divergent copies still live, every future ECMAScript edge case / new ValType must be fixed in N places again and **will drift again**. Dedup kills the whole *class* of drift bugs — that's durable correctness value, not cosmetics.
- "Zero test262 payload" is the wrong lens. The user (compiler-strategy thinker) values the architecture being **correct-by-construction**, not just the conformance number moving. Structural/maintainability value counts.
- **Stability-first argues FOR dedup, not against** — divergent copies ARE an instability source. I had it backwards.
- This is exactly the **#1530 single-path goal** (IR replaces the hacks; make the unified path the only path). Consolidation epics (#1917 coercion, #1927 pipeline) are that direction.

**How to apply:** Don't park / deprioritize a behavior-neutral consolidation just because it lacks an immediate test262 delta. Do it — but SAFELY: phased (one canonical fn at a time: ToString→ToNumber→ToBoolean→ToPrimitive, equality LAST/isolated vs the #1888 −794 tag-5 contract), each step its own small PR, prove diff-neutrality over playground/examples + standalone suite, ratchet the drift-gate baseline toward 0, merge_group-gate each step. Escalate only if a step proves NOT behavior-neutral (a hidden divergence between copies = a real bug to surface). Related: [[feedback_compile_away]], [[feedback_nothing_impossible]].
