---
name: reference_git_show_ref_glob_no_expand_use_ls_tree
description: To test whether a file exists on a git ref by pattern, use git ls-tree (globs work) — git show <ref>:dir/*.ext does NOT expand globs and false-negatives
metadata:
  type: reference
---

Checking "does a file matching `<pattern>` exist on `<ref>`" with
`git show <ref>:plan/issues/<id>-*.md` is WRONG: `git show <ref>:<path>` treats
`<path>` **literally** — no glob expansion — so it looks for a blob named
`<id>-*.md`, fails, and you wrongly conclude the file is absent. (The shell also
won't pre-expand the glob because the pattern lives in the repo at that ref, not
the working tree.)

**Use `git ls-tree` instead:**
```bash
git ls-tree -r --name-only <ref> -- plan/issues/ | grep -E '/<id>-'
# or to read it:
git show <ref>:"$(git ls-tree -r --name-only <ref> -- plan/issues/ | grep -m1 '/<id>-')"
```

**Why it matters:** on 2026-06-24 this false-negative made me tell dev-2642 to
*author* an issue file (`2642-*.md`) that already existed on main (filed via the
#2008 PR) — the dev created a duplicate, tripping the `check:issue-ids` /
"duplicate IDs" quality gate, costing a CI round-trip. The dev recovered by
reusing the canonical file and deleting its dup.

**How to apply:** before instructing an agent to create an issue/doc file
"because it's not on main," verify with `git ls-tree -r --name-only <ref>` (which
honors patterns via grep), never `git show <ref>:<glob>`. The dup-ID gate
(`check:issue-ids:against-main`) is the backstop, but catching it pre-dispatch
saves the cycle. See [[reference_subissue_filename_dupid_gate]].
