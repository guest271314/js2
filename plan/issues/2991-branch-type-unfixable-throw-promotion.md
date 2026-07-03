---
id: 2991
title: "Promote branch-type-unfixable to an unconditional structured compile error (staged follow-up of #2140)"
status: ready
sprint: Backlog
created: 2026-07-02
priority: medium
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: compiler
language_feature: compiler-internals
goal: correctness
related: [2140, 1918, 2090, 1917]
origin: "#2140's staged rollout — recording landed there; the throw needs measured-zero evidence first"
---

# Promote `branch-type-unfixable` to an unconditional compile error

## Problem

#2140 made detected-but-unbridgeable branch type mismatches (e.g. funcref→f64)
LOUD: `fixBranchType`'s fall-through records a lossy `branch-type-unfixable`
FixupEvent — visible in the per-compile summary, a hard error under
`JS2WASM_STRICT_BALANCE=error`, and pinned at 0 by the
`check:stack-balance` corpus ratchet. But in the default mode the compile
still "succeeds" and the module fails `WebAssembly.validate` later with an
opaque offset-only error.

## Why it was staged (do not skip this reasoning)

`inferLastType` is a heuristic over the LAST instruction of a branch body
with no locals context. A wrong inference at this site is a harmless no-op
today (nothing inserted; if the types were actually fine the module
validates and runs). Promoting to an unconditional throw converts a wrong
inference into a spurious compile failure on a working program — strictly
worse. The promotion therefore needs measured-zero evidence first.

## Acceptance criteria

- Evidence: the corpus row has stayed 0 AND a full test262 CI run (both
  lanes) shows zero `branch-type-unfixable` occurrences (add a counter dump
  to the sharded runner or spot-audit via `JS2WASM_STRICT_BALANCE=1` logs).
- Then: route the fall-through through the #2090 `inventedValueSites`-style
  hard-error list (structured `Codegen error:` naming function + from→to
  pair) unconditionally, delete the event-only arm.
- Equivalence + test262 green with net-zero delta.

## Pointers

- `src/codegen/stack-balance.ts` — `fixBranchType` fall-through (the
  `branch-type-unfixable` recordFixup), `inventedValueSites` mechanism at
  the end of `stackBalance`.
- `tests/issue-2140-fixbranchtype.test.ts` — the unfixable tests to update
  from "records an event" to "fails the compile".
