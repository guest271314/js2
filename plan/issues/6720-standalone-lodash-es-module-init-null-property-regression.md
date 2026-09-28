---
id: 6720
title: "standalone: lodash-es module-init throws `Cannot access property on null or undefined at 10:22` (regression on main after #6175)"
status: ready
sprint: Backlog
created: 2026-09-28
updated: 2026-09-28
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bug
area: compiler
goal: standalone
requested_by: ttraenkler/sendev-standalone
related: [6684, 6704, 6690]
---

# #6720 — lodash-es standalone module-init regression on main

## Problem

The lodash-es npm-compat `standalone-dynamic` lane
(`npx tsx scripts/generate-npm-compat-report.mjs --only lodash-es --no-write
--perf-only --lane standalone-dynamic`) now stops at module init, verbatim:

```
status: runtime-error   phase: module-init
TypeError: Cannot access property on null or undefined at 10:22
```

## Measured

| code | lane result |
|---|---|
| `c2601efa89` + PR #6175 (#6684) branch + #6704 fix | `measured`, checksum 54 = 54 |
| main `37b11b2891` (#6175 merged), `calls-closures.ts` exactly as on main (no #6704 change) | the module-init TypeError above |
| main `37b11b2891` + #6704 fix | the same module-init TypeError |
| main `f2e06e1224` + #6704 fix | the same module-init TypeError |

So it is not caused by #6704. It reproduces on main's own code and was
introduced between `c2601efa89` and `37b11b2891`. Other merges in that range
(`git log --first-parent c2601efa89..37b11b2891`): #6154 (#6690 standalone map
union callback), #6208 (`issue-lodash-next-standalone`), #6209. Not bisected.

The smaller `package/string.js` barrel graph (`words` + `kebabCase` through the
barrel, ~25 s compile) initializes and answers correctly on the same code, so
the failing module is outside that barrel's closure.

## Acceptance

- The lane gets past module-init again (back to the #6704 state: `measured`,
  checksum 54 = 54).
- A regression test pins the failing module-init shape.
