---
name: reference_resume_runs_lead_model_not_agent_fable
description: "SendMessage-RESUMING a dormant background agent runs that turn on the LEAD/parent session model (Opus 4.8 here), ignoring BOTH the agent's model:fable spawn param AND the agent-def model: frontmatter. Fresh Agent spawns DO honor the def/param (→ fable). So to keep work on fable: spawn fresh + keep agents ACTIVE/self-serving; NEVER rely on resuming dormant agents (every resume is an Opus turn). Can't be fixed mid-session (lead model is pinned)."
metadata:
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

**Diagnosed 2026-07-12 (fable-eqfix flagged it, confirmed by transcript census
+ a controlled resume test).** Model resolution for a subagent is
`explicit spawn param > agent-def frontmatter model: > parent/lead model`.

- **Fresh `Agent({model:"fable"})` spawn → runs on `claude-fable-5`.** ✓ The
  override works at spawn. (Even without the param now — see the def fix below.)
- **`SendMessage`-RESUME of a dormant/completed agent → runs that turn on the
  LEAD's model (`claude-opus-4-8`).** Resume has NO model parameter, and it
  **ignores the agent-def model too** — it inherits the parent lead session
  model. Verified: after changing the defs to `model: fable`, a resume of
  fable-architect STILL logged one `claude-opus-4-8` turn (its 115 original
  spawn turns were all fable-5).
- **This can't be fixed mid-session** — the lead's own model is pinned
  (Opus 4.8 here) and can't be changed; SendMessage can't pass a model.

**Root cause of the stale config:** `.claude/agents/{senior-developer,
developer,architect}.md` pinned `model: opus` despite the 2026-07-02 "devs
default fable" directive (see [[feedback_devs_default_opus]]) — the frontmatter
was never updated. FIXED 2026-07-12: defs → `model: fable`, so param-less
spawns now default fable. (This fixes SPAWNS only, NOT resumes.)

**Operational rules to keep work on fable:**
1. **Spawn fresh; never rely on resuming a dormant agent** — every resume is an
   Opus turn. fable-gen stayed pure `claude-fable-5` across 478 turns by keeping
   itself active + self-serving the next slice; fable-eqfix went mostly-Opus
   (577 Opus / 209 fable) because I resumed it ~10× fighting the treadmill.
2. **Instruct spawned agents to STAY ACTIVE / self-serve** (background CI
   watcher, self-claim the next slice, don't idle waiting to be resumed) — the
   [[feedback_idle_waiting_agent_not_terminated_dont_reassign_pr]] dormancy that
   forces resumes is what leaks Opus.
3. **Verify actual model via the transcript `model` field, NOT the agent's
   self-report** — an agent reads the model from its *latest turn's* context, so
   a resumed agent self-reports "Opus" even if its original work was fable
   (fable-eqfix did exactly this, causing a false "the whole fleet is Opus"
   alarm). Grep `'"model"[: ]*"claude-[^"]*"'` in the task `.output` transcript.

Related: [[feedback_devs_default_opus]], [[feedback_sonnet_for_sprint_loop]].
