---
name: reference_ci_quality_format_uses_prettier_not_biome
description: CI quality gate's format check runs prettier --check (not biome); run prettier --write before pushing or quality fails on a format-only mismatch
metadata:
  type: reference
---

The CI `quality` job (ci.yml) format check runs **`prettier --check`** over
roughly `'src/**/*.ts' 'tests/**/*.ts' 'scripts/**/*.ts'`. But `npm run lint`
(and what most agents run locally) uses **biome** — a DIFFERENT formatter with
different rules. Code that is biome-format-clean can still FAIL the CI `quality`
gate on a prettier mismatch, with no logic problem at all.

**Why it matters:** this bit TWO separate agents in one session (sdev-2635 on
#2012, dev-1772-p2 on #2014) — each pushed biome-formatted code, `quality`
failed on the prettier format check, and they had to re-run `prettier --write`
and push again, costing a CI round-trip apiece.

**How to apply:** before pushing, run **`prettier --write`** on the changed
`.ts` files (NOT just `biome format`), then verify with `prettier --check`. Both
tools' clean-states must hold: prettier for the `quality` gate, biome for
`npm run lint`. When a green-looking PR fails ONLY the `quality` job's format
step, suspect this mismatch first — it's a formatting no-op, not a logic
regression. (Worth folding into the pre-commit checklist.)
