---
name: feedback_no_double_dispatch
description: "Before spawning a fresh agent for a task, check no active teammate is already on it (avoid duplicate-PR collisions)"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 8d9a5e7c-ee71-42b6-8e54-753ae07c8f9f
---

Don't dispatch a task to a newly-spawned agent without first checking whether an **already-active teammate** is self-serving it. On 2026-05-29 the tech lead spawned a dedicated dev for task #261 (#389 native-messaging fix) while **dev-a was already doing it** (it had #389 context from prior work and self-served it). Result: two near-identical PRs (#944 dev-a, #945 dedicated dev) for the same fix — one had to be closed, wasting a full dev cycle.

**Why:** the team runs on a self-serve TaskList + agents that pick up adjacent work proactively. Spawning a fresh agent for a task an active dev is already on guarantees a collision (duplicate branches/PRs, same root-cause re-derived twice).

**How to apply:** before `Agent`-spawning or dispatching task X, scan for an active teammate already on X — check recent teammate messages, open PRs touching the same files (`gh pr list`), and whether a context-rich dev (one that filed/triaged the issue) is free. Prefer routing to the agent with existing context over spawning a new one. If you must parallelize, give the agents **disjoint** slices, never the same task. When a collision does happen: keep the more complete / CI-green PR, close the other as a dup with a clear comment, and own the miss to the displaced agent (its work wasn't wrong, just redundant). Relates to [[feedback_dev_self_serve_tasklist]].
