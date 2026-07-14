---
name: feedback_idle_waiting_agent_not_terminated_dont_reassign_pr
description: A background teammate's "completed" task-notification (or a transient SendMessage "not reachable") means it STOPPED THAT TURN — often idle-waiting on its own background CI watcher — NOT that it terminated; don't spawn a replacement or reassign its in-flight PR without verifying, or two agents collide on one branch.
metadata:
  node_type: memory
  type: feedback
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

A background dev teammate that has opened a PR and backgrounded a CI watcher goes
quiet and emits a `<task-notification>` with `status=completed` — but it is
**still alive**, resumable, and will wake when its watcher fires. A one-off
SendMessage "No agent named X is reachable" can also be transient (the agent is
mid-watcher-cycle), not proof of termination.

**Hazard:** treating that as "the agent exited" and (a) spawning a replacement
and/or (b) reassigning its in-flight PR/branch to another dev → two agents on one
branch → clobber risk (one force-pushes over the other's fix).

**What happened (2026-07-10):** fable-2856 opened PR #2857, backgrounded a
watcher, notified `completed`; an earlier shutdown SendMessage returned "not
reachable". I concluded it exited and told fable-9th to rescue #2857. fable-2856
was actually alive and had already rescued #2857 itself (pushed 864d10ea71).
Caught it only by checking the PR head before fable-9th pushed; redirected
fable-9th to a different task. No clobber, but it was luck of timing.

**Rule:** before spawning a replacement for or reassigning the PR of an
apparently-done teammate, VERIFY termination — check the PR head/state
(`gh pr view <N> --json headRefOid,mergeStateStatus`), and prefer a targeted
SendMessage to the agent ("are you still on X?") over assuming. Idle-waiting on a
watcher is the healthy state (see [[feedback_dev_silence_protocol]]); silence ≠
exit. If two agents must touch one branch, one drops it — never both push.
Related: [[feedback_no_shared_worktree_assignment]],
[[feedback_shared_worktree_clobber_check_claim_first]],
[[feedback_background_teammate_shutdown_limitation]].
