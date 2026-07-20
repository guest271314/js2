---
id: 3314
title: "scripts/lib/change-scope.mjs frontmatter parser silently drops allow-list items after a leading comment line"
status: done
sprint: 72
created: 2026-07-16
completed: 2026-07-16
priority: high
feasibility: trivial
model: fable
horizon: s
task_type: bug
area: ci-infra
goal: test-infrastructure
related: [3131, 3279, 3303, 3306]
---

# #3314 — allow-list parser drops items when preceded by an explanatory comment

## Problem

PR #3138 (#3306) declared, correctly per the documented format:

```yaml
coercion-sites-allow:
  # __str_to_number +2 — NOT a fresh hand-rolled matrix: routes the toString
  # closure result through the EXISTING StringToNumber scanner (the same
  # helper the direct string→f64 arm uses), replacing a spec-violating
  # drop+NaN.
  - src/codegen/type-coercion.ts
```

CI's Coercion-site drift gate (#2108/#3131/#3279) still failed as if **no**
allowance had been declared at all. Root-caused (not a dev mistake, not a
hand-rolled-matrix problem as first suspected by the PR-queue shepherd):
`parseFrontmatterList` in `scripts/lib/change-scope.mjs` scans the block
list line-by-line and `break`s on the **first line that doesn't match
`^\s+-\s+(.+)$`** — which includes `#`-comment lines. Since the dev's
comments came _before_ the actual `- src/codegen/type-coercion.ts` item,
the parser broke immediately and returned an empty list, silently granting
nothing.

`parseFrontmatterCountReason` (the #3303 numeric-allowance counterpart used
by `regressions-allow`) has the identical bug in its nested `count:`/
`reason:` scalar-block scan.

Confirmed via direct repro before touching the parser:

```js
parseFrontmatterList(
  `---
coercion-sites-allow:
  # comment
  - src/codegen/type-coercion.ts
---
`,
  "coercion-sites-allow",
);
// => []  (should be ["src/codegen/type-coercion.ts"])
```

This is a real landmine for every future PR: the gate's own failure message
explicitly encourages writing an explanation ("If this growth is an
intentional, reviewed migration step, grant THIS change-set an
allowance..."), and the natural writing order is explain-then-list — exactly
the order that silently defeats the parser.

## Fix

Skip blank and `#`-comment lines while scanning both block forms, in both
`parseFrontmatterList` and `parseFrontmatterCountReason`
(`scripts/lib/change-scope.mjs`). Still `break`s correctly on a true dedent
(an unindented top-level YAML key can never match the indented
`^\s+...` patterns, so no risk of over-reading past the intended block).

Verified with three cases: the exact failing #3138 shape (now parses to
`["src/codegen/type-coercion.ts"]`), a `regressions-allow` block with an
inline comment (`count`/`reason` still parse), and a no-overrun check
(a real trailing top-level key still terminates the scan correctly).
Permanent repro: `tests/issue-3314.test.ts` (5 cases, covers both parser
functions with and without interior comments, plus the no-over-read
regression guard).

## Immediate unblock for #3138 (not part of this fix)

Reordering the frontmatter so the list item precedes the comment also
works around this without a parser change — noted for the #3306 dev in
case this fix hasn't landed yet by the time they see this.

## Acceptance criteria

- `parseFrontmatterList` and `parseFrontmatterCountReason` tolerate
  interior blank/comment lines in their block-list scan.
- No change to the documented allow-list frontmatter format — this is a
  parser fix, not a spec change.
- PR #3138's existing `coercion-sites-allow` declaration (unmodified)
  passes the gate once this lands and #3138 rebases/re-merges main.
