---
id: 2645
title: "Compose the node:<mod> capability gate (#1772 P2) with --platform node|web (#2528) — ambient surface ⊕ importable surface"
status: done
completed: 2026-06-25
assignee: ttraenkler/sdev-2528-2645
created: 2026-06-24
updated: 2026-06-25
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

## Resolution (2026-06-25, shipped with #2528 in one PR)

The single composition point is `emulateNode`. Implemented as an OR at two
mirrored sites so the ambient surface (#2528) and the importable capability gate
(#1772 P2) agree on one target model:

- `src/checker/index.ts` — `resolveEmulateNode(opts)` returns
  `opts.emulateNode === true || opts.platform === "node"`. It drives the
  `buildNodeEnvDtsForSource` injection in `analyzeSource`, so `--platform node`
  implies the node-emulation injection path. The DOM-free ambient lib is
  selected by the same `platform` (`defaultLibNameForPlatform`).
- `src/compiler.ts` — `effectiveEmulateNode = options.emulateNode === true ||
  options.platform === "node"` drives the TS2580 "add `--emulate node`" message
  gate, so a `--platform node` host isn't told to add a flag it already implies.

No double-gating / contradiction: the per-member `providersFor` /
`isMemberSatisfiable` gate (landed #1772 P2-a/P2-b, #2634) stays the **authority**
for importable `node:<mod>` members — `--platform` only sets the **ambient
default**. A `--platform node` + `emulateNode: false` program still emulates
(platform wins via OR), confirming the two axes can't disagree.

Precedence with `--target wasi`: independent axes — `--platform` governs the
ambient surface, `--target` the backend; documented on `CompileOptions.platform`
in `src/index.ts`. Validated byte-neutral (sha256 + `runTest262File`) for
programs not setting `--platform`. Tests:
`tests/issue-2528-2645-platform-node-web.test.ts`.

**#1772 stays `in-progress`** — its other children (#2646/#2647) are separate
PRs; this only closes P2-c.
