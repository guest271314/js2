---
name: feedback_prettier_not_biome
description: "Format src/tests files with prettier (repo's format:check + pre-push gate), NOT biome — biome's wrapping is prettier-incompatible and fails CI's quality job"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 8d9a5e7c-ee71-42b6-8e54-753ae07c8f9f
---

The repo's authoritative formatter is **prettier** (`format:check` = `prettier --check 'src/**/*.ts' 'tests/**/*.ts' 'scripts/**/*.ts'`, run by the pre-push hook AND CI's `quality` job's "Format check" step). `lint` uses biome but only for *lint rules*, not format.

**Why:** running `biome format --write` on TS files produces multi-arg-signature wrapping that prettier 3.8.1 rejects. It passes `biome check` locally but fails CI `quality`/format:check. On 2026-05-30 (a3 #974) this cost a CI cycle: biome-wrapped emitter signatures failed CI format-check while local `biome check` was clean.

**How to apply:** before committing TS edits, run `npx prettier --write <files>` (or `pnpm run format:write`), never biome for formatting. Verify the **committed** content (not just working tree) is clean: `git show HEAD:path | npx prettier --check --stdin-filepath path` — a `git commit --amend` can strand the prettier --write output uncommitted in the worktree (it then survives a later merge and CI catches the stale committed version). After `prettier --write` + `git add`, confirm `git status` shows no further unstaged changes to those files before pushing.
