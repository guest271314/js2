# Codex Symphony Sprint Dispatch

Codex Symphony is this repo's markdown-driven sprint orchestration model for
Codex. It is not a native shared TaskList. The tech lead owns the queue,
spawns bounded workers in parallel, and keeps refilling open worker slots from
the current sprint until the sprint has no claimable work left.

## Source Of Truth

- Queue source: issue frontmatter in `plan/issues/<id>-<slug>.md`.
- Current sprint: the sprint number named by the user, or the latest
  `plan/issues/sprints/<N>.md` with active/planning work.
- Claimable task: `sprint: <N>` and `status: ready`.
- Claimed/running task: `status: in-progress`; do not fresh-dispatch it as
  another task.
- Blocked task: `status: blocked`, missing dependency, explicit owner pin, or
  known same-function conflict.
- Completion source: the implementation PR updates the issue file to
  `status: done` and adds `completed: YYYY-MM-DD`.

Sprint docs are planning snapshots. Issue frontmatter is authoritative when the
two disagree.

## Start Command

The user starts the loop with a prompt like:

```text
Start Codex Symphony for sprint 58 with max 3 workers.
```

If no sprint is named, the lead uses the highest numbered sprint doc with
non-done work and states that choice before dispatching.

## Lead Loop

1. Verify lead context: `pwd` is `/workspace`, branch is `main`, and the main
   checkout is orchestration-only.
2. Read `.claude/memory/MEMORY.md`, `AGENTS.md`,
   `plan/method/codex-multi-agent-worktrees.md`, and the selected sprint doc.
3. Build the candidate queue from issue files where `sprint: <N>` and
   `status: ready`.
4. Rank candidates by lowest issue id unless the sprint doc says otherwise.
5. Pick a wave up to the worker cap, avoiding overlapping write scopes,
   especially the same compiler function.
6. For each selected issue:
   - immediately set the issue frontmatter to `status: in-progress`
   - create or assign a worktree and branch
   - spawn one Codex worker/developer with exactly one issue
   - include the issue file, sprint number, worktree, branch, write scope, and
     validation expectations in the prompt
7. While workers run, the lead does non-overlapping orchestration work:
   inspect completed worker results, prepare follow-up dispatches, update
   sprint notes, and handle blockers.
8. When any worker finishes, review its result, integrate or mark blocked, then
   immediately dispatch the next claimable issue if the worker cap allows it.
9. Stop only when one of these is true:
   - no claimable sprint tasks remain
   - worker cap cannot be filled without conflicts
   - a blocking decision requires the user
   - token/budget/approval limits require stopping

Default worker cap is 3 developers plus an optional PO/planning worker. Raise
it only when the user explicitly asks and memory/RAM are healthy.

## Worker Contract

A Codex Symphony worker receives one assigned issue. It must not self-serve a
second issue from a TaskList or sprint doc.

The worker:

- works only in the assigned worktree
- reads the assigned issue file and relevant repo guidance
- updates the issue frontmatter/status as part of its implementation branch
- writes tests in `tests/issue-<N>.test.ts` unless the issue says otherwise
- runs scoped validation, not full local test262
- reports changed files, validation, branch, PR/merge state, and blockers
- stops after the assigned issue is complete, blocked, or handed back

## Worker Prompt Template

```text
You are a Codex developer worker for js2wasm in the Codex Symphony sprint loop.

Assigned sprint: <N>
Assigned issue: #<ID> <title>
Issue file: /workspace/plan/issues/<id>-<slug>.md
Assigned worktree: /workspace/.codex/worktrees/<branch>
Assigned branch: <branch>
Main checkout: /workspace, orchestration-only.
Allowed write scope: <files/modules/functions>

Do all reads, writes, tests, and git commands from the assigned worktree unless
I explicitly say otherwise. Do not edit /workspace directly. Do not revert or
overwrite changes made by other agents. You are not alone in the codebase.

Before substantial work, read AGENTS.md and .claude/memory/MEMORY.md from the
repo. Implement only this issue. Do not claim another task when done.

Validation expectation: <scoped command/test262 cases/equivalence checks>

When done, report changed files, validation run, branch, PR/merge state, and
any blockers.
```

## Markdown Sprint Drop

To add work to a running Symphony sprint:

1. Create or update `plan/issues/<id>-<slug>.md`.
2. Set `sprint: <N>` and `status: ready`.
3. Add dependency fields if needed, especially `depends_on`.
4. Optionally add the issue to the sprint doc table for human readability.
5. Tell the lead: `refresh sprint <N> queue`.

The lead then rebuilds the queue from frontmatter and dispatches any new
claimable issue when a worker slot is free.

## Conflict Policy

- Same file is acceptable only when the affected functions are disjoint.
- Same function, shared type contract, or shared test fixture means one worker
  at a time.
- If a worker discovers a conflict, it reports the conflict and stops rather
  than resolving another worker's edits blindly.
- The lead can spawn read-only explorers for overlapping analysis because they
  do not write.

## State Notes

Codex has no native persistent shared TaskList for subagents. Symphony uses
repo markdown as durable state and the active lead thread as the dispatcher.
If the lead thread stops, the next lead resumes by rereading issue frontmatter,
the sprint doc, open PRs, and active worktrees.
