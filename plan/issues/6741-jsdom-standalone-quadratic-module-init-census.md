---
id: 6741
title: "jsdom standalone compile does not finish: per-body-source module-init census re-validation is quadratic"
status: ready
sprint: Backlog
created: 2026-09-28
updated: 2026-09-28
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: performance
area: compiler
goal: npm-library-support
lane: A
related: [3494, 3525]
files:
  - src/codegen/multi-prepared-module-init-census.ts
  - src/codegen/multi-prepared-program.ts
  - src/codegen/context/locals.ts
---

# #6741 — jsdom standalone compile does not finish (quadratic census re-validation)

## Problem

Once #3494 let standalone `import()` compile, the jsdom `standalone-dynamic`
lane stopped failing in 56 s on the dynamic-import refusal and instead ran
more than 60 CPU-minutes without finishing (killed). CPU profiles (8 s
samples via the inspector, 2026-09-28) of `compileProject` on the lane driver:

- ~70 % of samples: `#stateForBodySource` →
  `assertMultiPreparedModuleInitCensusCurrent`
  (`currentSourceSyntax` / `captureLegacyObservation` /
  `nodeSyntaxScalarFields` / `terminalRecordsFor`). The assertion re-walks
  EVERY source's syntax on each body-source compile: O(sources x graph
  syntax). With the assertion short-circuited locally (diagnostic only) the
  compile still ran >25 CPU-min, now in `compileDeclarations` self time.
- Earlier phase: `snapshotLocals` (`speculative.ts`) copies the whole
  `localMap` per speculative object-literal compile in the flattened module
  init — GC-bound on a module init with a very large local count.
- (Fixed in #3494: `receiver-flow-analysis.ts` `resolveLocalBinding`
  re-walked every enclosing scope per receiver.)

## Acceptance criteria

- The census invariant is checked once per source (or incrementally), not
  per body source over the whole graph; same invariant strength.
- jsdom `--lane standalone-dynamic` reaches a verdict (pass or a named
  codegen blocker) within the lane budget; report the next blocker verbatim.
- Standalone output byte-identical on the dogfood-validation set.
