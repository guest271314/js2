# Sprint 77 retrospective

**Numbers, completed-issue list and action items live in
[`plan/issues/sprints/77.md`](../../issues/sprints/77.md)** — under the rolling
budget-window model (#2751) the freeze record written by `freeze-sprint.mjs`
*is* the retrospective of record. This file carries the two post-mortems that
are too long to sit inline there.

---

## Post-mortem 1 — `git worktree prune` deleted another session's live worktrees

### What happened

A cleanup pass ran `git worktree prune` from inside the container. It removed
~25 worktree registrations, several belonging to a **live** session.

### Why it was wrong

This repo is worked from **two environments sharing one `.git`**:

| | repo path | worktrees |
|---|---|---|
| container | `/workspace` | `/workspace/.claude/worktrees/…` |
| host (macOS) | `/Volumes/Archiv Mini/Users/thomas/Code/ts2wasm` | `/private/tmp/js2-*` |

One `.git` means **one worktree registry**. From the container,
`/private/tmp/js2-*` does not exist, so `git worktree list` marks every host
worktree `prunable` and `prune` deletes it. The label describes *visibility from
the current mount*, not staleness.

### How we know it hit live work

- `js2-3836-control` was registered at `88e12f2` — the main tip from minutes
  earlier.
- `js2-3836-repair`'s branch advanced `b96b016 → 0fc0989` **between two
  consecutive commands** in the same investigation.
- Registry entries reappeared during the session (3 → 4), i.e. the other session
  was actively re-creating them.

### Blast radius

Bounded. Commits and refs live in the shared object store and were never at
risk; what died was registration plus any uncommitted working-tree edits.

### Recovery (host-side only)

`git worktree repair` from the container cannot fix host worktrees — their
`.git` files reference a host gitdir that does not resolve here.

```bash
cd "/Volumes/Archiv Mini/Users/thomas/Code/ts2wasm"
git worktree repair /private/tmp/js2-*
```

### Prevention

- Never run `git worktree prune` from the container. Worktree cleanup is a
  **host-side** operation for this repo.
- Never treat `prunable` as a delete signal here.
- Before deleting a worktree directory, prove the content is recoverable. The
  cheap discriminator: `git hash-object <file>` then `git cat-file -e <sha>` —
  if the blob is already in the object DB, that exact content was committed and
  deletion loses nothing.

### The 283 orphans are the same bug, already fired

`/workspace/.claude/worktrees/` holds 283 directories against 4 surviving
metadata entries; `git status` inside them fails with *"not a git repository"*.
That is accumulated residue of this same cross-environment prune, ~47 GB on a
volume at 94% capacity. Cleaning it up is worthwhile but is **not** the trivial
`prune` it appears to be.

---

## Post-mortem 2 — "green" kept meaning "did nothing", twice

Two unrelated gates in this window reported success while doing no work:

1. **Summary sync (#3658)** — ran and reported SUCCESS at 18:29, 19:45, 21:27,
   22:28 and 23:32Z, committing nothing, while fresh baseline data existed. The
   landing page sat frozen at `15:43Z / 30390-43098` for ~9h.
2. **`quality`** — an early step aborting under `bash -e` skips the later gates
   entirely, while the step that did run reports fine.

The shared lesson: **a green conclusion is not evidence the job did its work.**
Diagnosis must confirm the *effect* (the commit, the artifact, the gate that
actually executed), never the *conclusion*. This cost real time here, because a
genuine promote outage looked unfixed when its visible symptom was a second,
independent bug.

Follow-up #3658 asks for the sync to **fail loudly** when it finds new baseline
data and produces no commit. That is still open — only the symptom is resolved.
