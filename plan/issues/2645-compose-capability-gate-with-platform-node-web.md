---
id: 2645
title: "Compose the node:<mod> capability gate (#1772 P2) with --platform node|web (#2528) — ambient surface ⊕ importable surface"
status: backlog
created: 2026-06-24
updated: 2026-06-24
priority: low
feasibility: medium
reasoning_effort: medium
task_type: feature
area: host-interop
language_feature: node-api-compat
goal: platform
sprint: Backlog
es_edition: n/a
depends_on: [2528]
related: [1772, 2528, 2624, 2634]
origin: "Slice P2-c of the #1772 Phase 2 capstone (arch-capstone scoping, 2026-06-24). Deliberately deferred from PR #2014 because it is gated on #2528 (--platform), which is itself backlog."
---
# #2645 — compose the capability gate with `--platform node|web` (P2-c)

## Problem

There are two orthogonal axes of "what host surface does this program target":

- the **ambient-global** axis — #2528 (`--platform node|web`): which globals
  (`window.stop`, DOM lib vs node lib) are in scope. Currently the compiler loads
  `lib.dom.d.ts` unconditionally.
- the **importable `node:<mod>`** axis — #1772 Phase 2 (landed in PR #2014): the
  capability gate (`isMemberSatisfiable` wired into `tryCompileNodeFsCall`) that
  errors precisely when an imported `node:fs`/`node:process` member has no
  provider under the chosen target.

These two compose at exactly one decision point. Today they are independent:
`buildNodeEnvDtsForSource` injection is gated by `emulateNode` in
`src/checker/index.ts` (~L573), and the ambient `LIB_GLOBALS`/`DOM_ONLY_GLOBALS`
sets in `src/codegen/index.ts` are #2528's territory. A `--platform node` program
should (a) drop the DOM ambient surface and (b) imply the node-emulation
injection path, while `--platform web` should do the opposite.

## Scope (deferred until #2528 lands)

- Wire `--platform` into the single `emulateNode` decision:
  `emulateNode ||= platform === "node"` (and the converse for the ambient lib
  selection), so the capability gate and the ambient global surface agree on one
  target model.
- Define precedence when `--platform` and `--target wasi` disagree (e.g.
  `--platform web --target wasi`): document the resolution.
- Keep the #1772 capability gate's per-member `providersFor` gating as the
  authority for importable members; `--platform` only sets the ambient default.

## Acceptance

- A `--platform node` program type-checks with the node ambient surface + node
  emulation injection, and a `--platform web` program excludes node globals.
- The #1772 capability gate composes (no double-gating, no contradiction) with
  the chosen platform.
- Validate IN BATCH + `runTest262File` (per #1968) — byte-neutral for programs
  not setting `--platform`.

## Out of scope

- #2528 itself (the `--platform` flag + ambient lib scoping) — that is the
  prerequisite this composes with.
- The importable `node:<mod>` capability map (landed: #2634, #1772 P2-a/P2-b).
