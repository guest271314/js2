---
id: 3964
title: "Pre-push issue-integrity gate spawns one `git show` per issue file (~3,500 subprocesses)"
status: done
sprint: current
priority: high
horizon: s
goal: developer-experience
completed: 2026-08-01
assignee: ttraenkler/dev-queue-tax
---

# Pre-push issue-integrity gate spawns one `git show` per issue file

## Problem

`.husky/pre-push` step 5b runs `scripts/check-committed-issue-integrity.mjs`,
which read every issue blob with its own `git show <ref>:<file>` subprocess.
The tree holds ~3,500 issue files, so every `git push` by every agent paid
~3,500 serial subprocess spawns.

Measured on the live box 2026-08-01: the process sat at **0.0% CPU** in state
`R` while its child `git show` churned through the list. It was **not
deadlocked** — which is exactly why "wait it out" kept failing. The cost is
spawn + object lookup, paid thousands of times, and it grows every time we
file an issue.

This is a pure tax: it is charged to every agent on every push, and the same
gate already runs whole-tree in CI (`quality` job), which is where the
exhaustive version belongs.

## Root cause

`scripts/check-committed-issue-integrity.mjs`:

```js
function showFile(file) {
  return git(["show", `${ref}:${file}`]); // one execFileSync PER FILE
}
```

The file **list** already came from a single `git ls-tree`. Only the file
**content** was read one subprocess at a time.

## Fix

Read every blob with ONE `git cat-file --batch`, fed every `<ref>:<path>` on
stdin. No change to what is checked or to the downstream logic.

Two details in the batch reader are load-bearing:

- Bodies are delimited by the **byte count** in the `<oid> blob <size>`
  header, never by scanning for newlines. Issue bodies contain lines that look
  exactly like a header, so line-splitting would corrupt them.
- A `<name> missing` response is a **hard error, not a skip**. The input list
  comes from `ls-tree` on the same ref, so a missing object means the reader
  is broken — and silently skipping would let a broken reader report a clean
  tree.

The hook was **not** scoped to touched files. Scoping would weaken the gate:
duplicate-ID and dangling-`depends_on` detection both need the whole index to
be sound. Batching made scoping unnecessary.

### False-green floor

`id` falls back to the filename prefix when frontmatter is unreadable, so a
reader that returned empty strings for every file would satisfy every check
and print `OK`. The checker now counts files that actually yielded
frontmatter, prints both counts on success, and **refuses to report OK** when
it scanned zero files or parsed zero frontmatter blocks.

## Measurements

Same pinned SHA `5824539805cb77`, same box, both read paths run back-to-back
in one harness so they share conditions.

| Read path                                | Wall clock |
| ---------------------------------------- | ---------- |
| old — one `git show` per file (3,514×)   | see PR body |
| new — one `git cat-file --batch`         | see PR body |

## Acceptance

- Byte-level content parity across all issue files between old and new read
  paths (identical content ⇒ identical derived state by construction).
- Positive control: a commit carrying a duplicate id, a filename/frontmatter
  id mismatch, and a dangling `depends_on` is **detected by both** old and new,
  with identical output.
- Scan count printed on success.

## Also in this change

Documented the **false-negative push** rule next to the hook: a
`timeout N git push` can be killed *after* the ref update has landed, so exit
124 is not evidence the push failed. Confirm with `git ls-remote`.
