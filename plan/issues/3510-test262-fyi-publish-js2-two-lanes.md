---
id: 3510
title: "Publish js2 host and standalone lanes on test262.fyi"
status: in-progress
created: 2026-07-21
updated: 2026-07-21
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: test262-runner
goal: test262-conformance
lane: A
related: [3473, 3490, 3491, 3494, 3509]
files:
  - scripts/run-test262-fyi.mjs
  - scripts/test262-fixture-graph.mjs
  - scripts/test262-fyi-engine-adapter.mjs
  - tests/issue-3510-test262-fyi-two-lane-engine-adapter.test.ts
---

# #3510 — Publish js2 host and standalone lanes on test262.fyi

## Problem

js2 can run the literal test262.fyi source assembly locally in both JS-host and
standalone modes, but test262.fyi cannot publish either result. Its generic
engine runner classifies child-process stdout and stderr heuristically. Sending
js2 through that path would duplicate the silent negative, async, fixture and
runtime-verdict mistakes already removed from the project runner.

The public site also needs two independent result identities: JS-host permits
the declared JavaScript host imports while standalone must remain host-free.
Combining them into one score would hide the capability boundary.

## Design

- Export a small direct-verdict adapter around the canonical FYI source worker.
- Accept test262.fyi's already assembled source record without rewriting it.
- Discover static and dynamic fixture metadata from the external Test262 clone,
  rather than assuming js2's optional submodule path.
- Allow the external controller to select `gc` or `standalone` explicitly.
- Allow the adapter to launch its canonical worker through a pinned Node
  executable supplied by the external setup.
- Keep strict reruns, negative phases, async completion, realm recycling and
  standalone host-import rejection inside the canonical worker.

The corresponding upstream data integration registers `js2_host` and
`js2_standalone`, adds a generic async direct-verdict adapter hook, and caps js2
worker concurrency. The frontend integration gives both result identities
distinct names and descriptions.

## Acceptance criteria

- An external Test262 checkout can supply a fixture graph without using the
  repository's `test262` submodule.
- Both `gc` and `standalone` return direct boolean-compatible verdicts through
  one shared adapter.
- Unsupported target names fail before any test is published.
- test262.fyi can run the adapter asynchronously without stdout/error keyword
  classification.
- The generated site data contains separate host and standalone engine keys.
- The frontend exposes both keys with unambiguous labels.
- Focused adapter, FYI runner and fixture-graph tests pass, followed by one
  original-harness smoke sample in both modes.

## Validation

- `tests/issue-3510-test262-fyi-two-lane-engine-adapter.test.ts`
- `tests/test262-fyi-runner.test.ts`
- `tests/issue-3491-test262-fyi-module-fixtures.test.ts`
- TypeScript, Prettier, issue-ID and issue-spec gates.
