---
name: feedback_5h_window_99pct_schedule_wakeup
description: "At 99% of the 5h token window — stop dispatching, wait, and wake EXACTLY once at the next 5h window start (single background sleep timer or one-shot cron; NOT hourly wakeup chains)"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

User directive (2026-07-02, refined): if 99% of the 5-hour window token budget is reached, WAIT (no new dispatch, no churn) and wake up EXACTLY when the next 5-hour window starts — one wakeup at the reset time, NOT chained hourly polling.

**Why:** avoids burning the tail of a window on partial work and avoids agents dying mid-task on the hard limit (like the Jul 1 weekly-limit strand); hourly wakeup chains waste tokens on no-op turns.

**How to apply:** trigger = harness 5h-usage warnings or agents/API returning "hit your limit · resets at HH:MM". Response: (1) tell active agents to reach a push-safe checkpoint if possible; (2) no new spawns/dispatch; (3) compute seconds until the stated reset and start ONE background timer that fires at exactly that moment — `Bash {command: "sleep <N>", run_in_background: true}` (background-task completion re-invokes the lead; foreground sleep is blocked; ScheduleWakeup is clamped to 3600s so it cannot span the gap) — or a one-shot CronCreate at the reset time; (4) on that single wakeup, resume the dispatch loop. The weekly cache (~/.claude/js2wasm-budget.json) only tracks the 7-day window, not the 5h one — rely on the live limit signals.
