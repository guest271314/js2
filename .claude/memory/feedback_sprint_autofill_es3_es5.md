---
name: feedback_sprint_autofill_es3_es5
description: "When the sprint TaskList runs dry, auto-pull ES3/ES5-fixing tasks into the current sprint"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8d9a5e7c-ee71-42b6-8e54-753ae07c8f9f
---

When the current sprint's claimable TaskList runs out of work (no unowned, unblocked, non-parked tasks left), **pull in tasks that fix ES3 or ES5 test262 failures** rather than letting devs idle — promote ES3/ES5 conformance issues from the backlog into the active sprint (set `sprint: <N>`) and `TaskCreate` them.

**Why:** the project lead wants the sprint kept continuously fed with high-value conformance work; ES3/ES5 (edition 0 and edition 5) buckets are well-scoped, mostly self-contained, and a reliable refill source. Set as a /goal on 2026-05-29.

**How to apply:** identify ES3/ES5 failures via `scripts/generate-editions.ts` (edition 0 = "≤ ES3", edition 5 = ES5) against the cached baseline JSONL; cross-check tracked issues; flip open ES3/ES5 issue frontmatter to the current sprint and add to the TaskList. Regressions of `done` ES-core issues (e.g. ToPrimitive [[reference_error_analysis]]) rank highest. Only triggers on a dry queue — don't displace in-flight sprint work.
