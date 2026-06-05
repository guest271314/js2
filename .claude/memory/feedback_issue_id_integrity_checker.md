---
name: feedback_issue_id_integrity_checker
description: New plan/issues/ files need a FRESH numeric id whose digits match the filename prefix — suffixed slice ids (1888-s6c) collide and block push
metadata:
  node_type: memory
  type: feedback
  originSessionId: bd85f78e-e46f-4c52-b752-d9a8f971f948
---

A pre-push hook (`scripts/check-issue-ids.mjs`, mode=workspace) enforces two
things on every `plan/issues/<id>-<slug>.md`:
1. **No duplicate issue IDs.** It NORMALIZES the frontmatter `id:` by stripping
   any non-numeric suffix — so `id: "1888-s6c"` collapses to `#1888` and collides
   with the existing `1888-...md`. A "slice"-style id reusing a parent number is
   rejected with `✗ --check FAILED: N duplicate ID`.
2. **Filename prefix must equal the frontmatter id exactly** (`FILENAME/FRONTMATTER
   ID MISMATCH`). `id: 1902` requires the file to be `1902-...md`.

**Why:** the checker keys issues by a single canonical numeric id; suffixed ids
break both the dedup map and the filename↔id invariant.

**How to apply:**
- For a new sub-slice of an existing issue (e.g. "#1888 S6-c"), allocate a
  **fresh numeric id** = (current max numeric id under plan/issues/, ignoring the
  special 64xx range) + 1, and name the file `<freshId>-<slug>.md`. Put the
  conceptual slice label in the `title:` / commit, NOT the `id:`.
- Run `node scripts/check-issue-ids.mjs` BEFORE committing the issue file (it's
  fast) to avoid a failed `git push` (the hook runs there).
- When fixing it via `git commit --amend`, remember the **staged** copy is what
  gets committed: re-`git add` the file AFTER editing the `id:`, and the
  `--amend` reuse path (`--no-edit`) re-trips the checklist hook — pass the full
  `-F -` message ending in the ✓ trailer.
- Sibling slices that DID get distinct ids: #1629 S1/S2/S3 used 1629 + separate
  files only because their ids stayed numeric-distinct; the suffix form does not.
