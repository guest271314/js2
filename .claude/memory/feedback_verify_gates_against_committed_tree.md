---
name: feedback_verify_gates_against_committed_tree
description: "When renaming/renumbering issue files, commit ALL edits then verify the gate against `git show HEAD:`, not the working tree"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 8d9a5e7c-ee71-42b6-8e54-753ae07c8f9f
---

When renumbering an issue file (e.g. dup-ID fix `1742 → 1743`), the rename has TWO parts that must BOTH be committed: (1) the `git mv` filename change, and (2) the in-file edits to frontmatter `id:` and the `# #NNNN` heading. A `git mv` + `git add <newname>` only stages the rename — Edit-tool content changes made afterward are a SEPARATE working-tree modification that needs its own `git add`. If you skip it, the commit lands filename-prefix=1743 but frontmatter-id=1742, and the #1616 integrity gate (`node scripts/update-issues.mjs --check`) fails on CI with `filename prefix=1743, frontmatter id=1742`.

**Why:** I ran `check:issues` locally and saw "PASS (exit 0)" — but that ran against the WORKING TREE (which had my uncommitted `id:1743` edits), not the COMMITTED tree CI checks out. The mismatch only existed in the commit. Cost a CI round-trip (#957, 2026-05-30).

**How to apply:** (1) After `git mv` + Edit-ing the `id:`/heading, run `git add <file>` AGAIN to stage the content edits, and confirm `git diff --cached` shows the `id:` change. (2) ALWAYS verify a gate against the committed tree: `git show HEAD:<path>` (or `git stash && check && git stash pop`), never the dirty working tree. (3) lint-staged saying "could not find any staged files" is a RED FLAG that your commit captured nothing of substance — re-check what's staged.
