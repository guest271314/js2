---
id: 3146
title: "standalone: Iterator.zip / zipKeyed / concat / from (~99 __get_builtin CEs)"
status: ready
sprint: current
priority: high
horizon: l
feasibility: hard
area: codegen, runtime
goal: standalone-mode
related: [2984]
origin: "#2984 __get_builtin cluster triage (fable-sub1, 2026-07-11)"
---

# #3146 — standalone Iterator static helpers (zip / zipKeyed / concat / from)

## Problem

The ES2025 Iterator static helpers `Iterator.zip`, `Iterator.zipKeyed`,
`Iterator.concat`, `Iterator.from` used standalone hard-CE through the
`__get_builtin` dynamic-shape refusal (#1472 Phase B). Measured **99** non-pass
standalone entries under `built-ins/Iterator/{zip,zipKeyed,concat,from}/`. This
is the largest single in-scope builtin-CALL-surface bucket in the #2984
`__get_builtin` triage.

## Sample paths

- `test/built-ins/Iterator/zip/iterator-zip-iteration-shortest-iterator-close-abrupt-completion.js`
- `test/built-ins/Iterator/zipKeyed/iterator-zip-iteration-strict-iterator-close-i-is-zero-abrupt-completion.js`
- `test/built-ins/Iterator/concat/return-is-forwarded.js`
- `test/built-ins/Iterator/concat/return-is-not-forwarded-after-exhaustion.js`

## Shared-infra deps

- Needs the standalone iterator-protocol substrate (open-object iterator
  result reads, `.next()`/`.return()` forwarding, abrupt-completion
  iterator-close). Much of the corpus exercises iterator-close ordering on
  abrupt completions — the hard part is the protocol plumbing, not the
  namespace recognizer. Likely wants an architect spec first (feasibility:
  hard). Consider splitting `from` (simplest — wraps an iterable) from
  `zip/zipKeyed/concat` (multi-source close semantics).

## Acceptance

- `built-ins/Iterator/{zip,zipKeyed,concat,from}/*` standalone tests compile +
  pass with 0 regressions on a passing-test sweep. May land as sub-slices per
  helper.
