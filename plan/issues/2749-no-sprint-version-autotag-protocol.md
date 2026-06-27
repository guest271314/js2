---
id: 2749
title: Sprint-end creates no vX.Y.Z version tags — release.mjs only
status: done
completed: 2026-06-27
sprint: 67
assignee: ttraenkler/agent-ace4f48e
type: docs
feasibility: easy
---

# Sprint-end must not auto-create `vX.Y.Z` version tags

## Problem

The repo accumulated 44 legacy `v0.x.0` tags from an old per-sprint / manual
version-tagging convention (loopdive/js2#389). Those bare lightweight tags never
touched `package.json`, so `publish-npm.yml` (which publishes whatever `version`
field `package.json` carries at the tagged commit) kept shipping a stale
`0.52.0`. That drift is exactly why `scripts/release.mjs` (lockstep
`package.json` bump) and the `verify-version` gate in `publish-npm.yml` now
exist.

The team protocol must make explicit that **sprint tagging creates ONLY
`sprint/N` (+ `sprint-N/begin`) tags and NEVER `vX.Y.Z` version tags**. Version
tags are cut exclusively via the deliberate `node scripts/release.mjs <x.y.z>`
release flow (reviewed release PR, lockstep package.json bump, tag-on-merge).

## Verification: no active auto-tagger

Grepped `scripts/`, `.github/workflows/`, `.claude/skills/` (incl.
`sprint-wrap-up.md`), `package.json`, and `build:pages`/`build-pages*` for any
code path that auto-cuts a `vX.Y.Z` tag. The **only** `git tag vX.Y.Z` site is
`scripts/release.mjs` (the deliberate release flow) plus a descriptive comment.
The active sprint protocol uses `sprint/N` + `sprint-N/begin` only. **No active
auto-tagger exists** — the change is documentation-only.

## Changes

- `CLAUDE.md` — sprint-tag protocol line: sprint tagging creates only
  `sprint/N` (+ `sprint-N/begin`), never `vX.Y.Z`; version tags are
  release-only.
- `.claude/skills/sprint-wrap-up.md` — `git tag sprint/N` step: explicit note
  that sprint-end does not tag a version.
- `docs/releasing.md` — note that version tags are release-only and sprint-end
  must not create them; reference the #389 legacy-bare-tag cleanup.

Existing legacy `v0.*` tags are public on upstream and are handled separately by
the release work — not deleted here.
