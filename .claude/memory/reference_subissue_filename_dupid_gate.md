---
name: reference_subissue_filename_dupid_gate
description: Sub-issue files under a parent
metadata: 
  node_type: memory
  type: reference
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

The `quality` CI job runs `check:issues` (`scripts/update-issues.mjs --check`), which derives each issue's id from the **filename's leading `\d+[a-z]?` prefix** (regex at update-issues.mjs ~L215: `name.match(/^(\d+[a-z]?)/i)`). A `-suffix` after the digits is IGNORED.

So a sub-issue file named `1910-r3-boolean-wrapper-tonumber.md` resolves to bare id `#1910` and COLLIDES with any other `1910-*.md` (e.g. `1910-standalone-toprimitive-residual-bucket.md`) → `check:issues` exits 1 → the required `quality` check fails the PR.

**Convention for sub-issues under a parent #N:** use an ALPHA suffix directly on the digits — `1910a`, `1910b`, `1910c` (no dash before the letter). e.g. `1910b-boolean-wrapper-tonumber.md` with frontmatter `id: 1910b`. This bit #1910 R3 (→1910b) and R4 (→1910c) on PRs #1768/#1771 (2026-06-19).

Also: the `quality` job runs `format:check` (prettier --check on src/tests/scripts) — long test-string lines must be prettier-wrapped or it fails. The biome lint step's "diagnostics exceed allowed" message is NOISE (biome exits 0); not a failure source.

Related: [[project_1910_r3_r4_boxed_wrapper_slots]].
