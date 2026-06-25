---
name: feedback_token_budget_guardrails
description: "Weekly token-budget guardrails — warn at 25%, force a break at 40%, hard stop at 50%; pace across the whole week"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

Weekly token-budget guardrails (user directive): **warn the user at 25%** of the
weekly budget consumed, **force a break at 40%**, **hard stop at 50%**. The
weekly budget covers the user's whole week of work — don't burn it in one
session.

**How to apply (the budget *tail*):** when the user says "X% left, use it" near a
week boundary, spend the remainder productively but do NOT start work that can't
finish in the remaining budget. Pipeline in-flight laps to completion, shepherd
their PRs to merge, and bank durable learnings / maintenance (e.g. memory
compaction, recording follow-up issues) rather than launching new multi-day
architecture laps that would run out mid-work. A new deep substrate lap costs
~250k tokens — too much for a low single-digit % tail. See
[[feedback_budget_is_own_agents_pipeline_not_idle]].
