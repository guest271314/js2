---
name: feedback_background_teammate_shutdown_limitation
description: "Background-spawned teammates can't complete the shutdown handshake; they clear on lead-session-end, not via shutdown_request"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: c0c4bdd0-104f-4dad-8e76-8be11c89a5c2
---

Teammates spawned with `Agent(team_name:"js2wasm", name:…, run_in_background:true)`
ARE teammates (named, addressable, on the TaskList, claim via the lock) — but
because they run in the **background**, the harness classifies them as
"background subagents" for protocol purposes. **Structured team-protocol
messages (`shutdown_response`/`plan_approval_response`/requests) are "acts of
the session itself" and can only be sent by a foreground interactive session.**
A background teammate can do all work + send PLAIN text ("approving shutdown")
but **cannot emit the structured response that finalizes a shutdown handshake**
→ it lingers/wedges and keeps idle-pinging.

**Why background at all:** the tech-lead session is itself a background job, and
a foreground teammate spawn (`run_in_background:false`) is SYNCHRONOUS — it
blocks the lead's turn until that agent finishes, so you can't orchestrate
concurrent agents. Background is required for a multi-agent team; the inherent
cost is the broken shutdown handshake.

**REUSE over respawn (the bigger lesson).** Teammates persist between tasks —
when one goes idle, `SendMessage` it the next task BY NAME (warm context, same
slot, same roster entry), per CLAUDE.md "dev between tasks: keep alive, claim
next task." Do NOT shutdown+respawn at task/sprint boundaries — that (a) bloats
the roster (shutdowns can't finalize, so the old ones linger AND the new spawns
add up — this is how a session hit 14 teammates), (b) pays re-ramp cost, (c)
hits the flat-roster spawn cap. Keep a SMALL STABLE POOL alive across the whole
session/sprint and redirect it; reserve shutdown for genuine end-of-all-work.
Reuse by stable NAME (not hex agent-id — messaging a stale agent-id spawns a
one-shot resume-from-transcript continuation, adding processes).

**How to apply:**
- Do NOT treat `shutdown_request` as a reliable teammate-cleanup lever — sending
  more is futile once an agent is wedged/rate-limited. They acked in text but
  can't finalize.
- Reconcile teammate WORK via the upstream lock ([[feedback_baseline_force_refresh_lever]]-adjacent
  claim ops: `--complete`/`--release`) + the merge queue, not the agent registry.
- There is **no clean, targeted in-session force-stop for an individual
  background teammate**: `shutdown_request` can't finalize (cooperative ack
  blocked); `TaskStop` does NOT apply to teammate agents — it only stops *Bash*
  background tasks (verified: TaskStop on a teammate name/agent-id → "No task
  found"); `TeamDelete` is all-or-nothing (dissolves the whole team, killing
  active workers too); `kill <PID>` works but the `--bg-spare` processes don't
  map cleanly to names (risk of hitting an active worker).
- So idle/wedged background teammates **clear on lead-session end** — that's the
  sanctioned cleanup. Don't promise a surgical stop you can't deliver. To reclaim
  slots mid-session at all costs you'd PID-kill (consequential/risky) — prefer
  letting them clear unless slots are truly blocking and no active worker is at risk.
- Rate-limiting compounds it (their acks/polls error+retry → repeated idle pings).
- A "Teammates cannot spawn other teammates" / "in-process teammates cannot spawn
  background agents" error on `Agent` means the flat roster is full — redirect
  existing teammates rather than spawn; roster frees on session-end.
