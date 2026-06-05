---
name: feedback_reduce_teammate_message_fanout
description: Teammate messages are point-to-point (not broadcast); idle_notifications are auto-emitted and non-suppressible — reduce rate-limiting by fewer teammates + subagents for one-shot work
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bd85f78e-e46f-4c52-b752-d9a8f971f948
---

User hit API rate-limiting from too many parallel dev teammates and asked whether teammate messages can be scoped to reach only the lead, not peers.

**Facts (confirmed via claude-code-guide against Claude Code docs):**
- SendMessage is **point-to-point** — a teammate message reaches only the named `to` recipient, never broadcast to peers. Teammate→lead messages already only reach the lead.
- The flood the lead sees is (a) everything routing to the lead as the orchestrator hub, and (b) `idle_notification` messages the harness auto-emits when a teammate goes idle.
- **There is NO setting** to gate/filter/throttle teammate messages or suppress idle_notifications (known limitation — bug #28627). Not configurable.

**Why:** idle-ping volume scales with the number of live teammates; there's no per-message control.

**How to apply:**
- Keep the persistent dev team small (user directive: **drain developing teammates to 4** when rate-limited). Fewer teammates = fewer idle pings. This is the biggest lever.
- Prefer **fire-and-forget subagents** (Agent without team_name) over persistent teammates for one-shot work (specs, research, guide queries) — a subagent reports once and exits with NO idle-ping stream.
- Comm-protocol discipline (status via TaskUpdate not SendMessage; no idle pings; message lead only for blockers/decisions/completions) is advisory-only — restate it but don't rely on it.
- Don't respond to bare idle_notifications — responding feeds the loop. See [[feedback_idle_notification_silence]].
