---
id: 2634
title: "@types/node → capability-map extraction for node:fs (Phase 2 of #1772)"
status: ready
created: 2026-06-24
updated: 2026-06-24
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature
area: host-interop
language_feature: node-api-compat
goal: platform
sprint: Backlog
es_edition: n/a
related: [1772, 2624, 2625, 2631, 2528, 2083, 2181, 2527]
origin: "Phase 2 split out of #1772 once Phase 0 (ABI) + Phase 1 (edge.js dual-provider proof) landed"
---
# #2634 — @types/node → capability-map extraction (node:fs)

Phase 2 of #1772. Phases 0 (the `node:fs` pointer-ABI, `docs/architecture/node-fs-abi.md`)
and 1 (the `edge.js` provider + same-binary dual-provider proof,
`examples/native-messaging/edge.js`, `tests/issue-1772-edge-dual-provider.test.ts`)
are done. This issue replaces the hand-written minimal typings with extraction
from `@types/node`, gated by a capability map.

## Problem

The compiler today recognizes a hand-written minimal set of `node:fs` members
(`buildNodeEnvDts` / `scanNodeEmuUsage`, #2624). The type surface of
`@types/node` is thousands of members, but only the subset with a runtime
provider (a `.wat` shim, an `edge.js` adapter, or a WASI mapping) is *linkable*.

Without a capability gate, a program type-checks against the full `@types/node`
surface then fails to **link** with an opaque error when it calls a member no
provider satisfies.

## Scope

- Drive the importable surface + types from `@types/node` (compose with #2528
  `--platform node`), replacing/extending the hand-written `buildNodeEnvDts`.
- Gate against a **capability map**: `@types/node` member → provider fn → host
  classes that can provide it. Only runtime-satisfiable members type-check clean.
- An **unsatisfiable** member (typed in `@types/node`, no provider) must produce
  a precise, deliberate compile error ("no provider for `node:fs.openSync` under
  `--target wasi`"), never a silent link failure.
- Anchor members: `node:fs` `readSync`/`writeSync` (already linkable per the
  Phase 0 ABI). Extend the map structure so adding `node:process`/`node:os`
  members later is a data change, not a code change.

## Acceptance

- A working `@types/node` → capability-map extraction for the anchor `node:fs`
  members, with the deliberate-error path for unsatisfiable members.
- Follow-up issues filed for further surfaces (process/os/path tiers).
- This is #1772 Phase 2; #2635 covers Phase 3 (async members, gated on #2632).
