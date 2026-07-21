---
id: 3516
title: "Keep the js2wasm proxy dependency in release lockstep"
status: in-progress
sprint: current
created: 2026-07-21
updated: 2026-07-21
priority: high
horizon: s
feasibility: easy
task_type: bug
area: ci, release
goal: release-pipeline
related: [2196, 3454, 3455]
files:
  - scripts/release.mjs
  - packages/js2wasm/package.json
  - .github/workflows/publish-npm.yml
  - tests/issue-3516-release-proxy-dependency-lockstep.test.ts
---

# #3516 — Keep the js2wasm proxy dependency in release lockstep

## Problem

`v0.64.0` correctly published all three package versions, but registry
verification showed that the unscoped `js2wasm@0.64.0` proxy still depended on
`@loopdive/js2@0.60.1`. `scripts/release.mjs` updated the proxy's own version but
never updated its canonical-package dependency, even though the script and
publish workflow documented that dependency as lockstep state.

Because npm versions are immutable, fixing the checked-in manifest alone cannot
repair `js2wasm@0.64.0`; a patch release must supersede it.

## Acceptance criteria

- [ ] The release script pins `packages/js2wasm`'s `@loopdive/js2` dependency to
      the target release version.
- [ ] The tag verification job refuses to publish when that dependency differs
      from the tag.
- [ ] Regression coverage checks the pure manifest update and checked-in
      root/proxy/dependency equality.
- [ ] A patch release publishes `js2wasm` with a dependency on the matching
      `@loopdive/js2` version.

## Validation

- `tests/issue-3516-release-proxy-dependency-lockstep.test.ts`
- Prettier, typecheck, issue-ID, and issue-spec gates.
- Registry metadata verification after the patch tag is published.
