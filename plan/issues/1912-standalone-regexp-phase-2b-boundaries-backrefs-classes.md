---
id: 1912
title: "standalone RegExp Phase 2b: word boundaries, backrefs, and character-class compatibility"
status: ready
sprint: 61
model: fable
created: 2026-06-07
updated: 2026-06-07
priority: critical
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: regexp
goal: standalone-mode
related: [1909, 1539, 682, 1474]
test262_bucket: standalone-regexp-phase-2b
test262_count: 104
---

# #1912 — Standalone RegExp Phase 2b parser/runtime features

## Problem

The standalone RegExp matcher still refuses Phase 2b pattern features and some
ES-compatible character-class forms. Current samples include word-boundary
assertions, backreferences, negated shorthand inside character classes, and
class range compatibility cases.

Representative signatures from the 2026-06-07 standalone JSONL:

- `word-boundary \b — #1539 Phase 2b`.
- `word-boundary \B — #1539 Phase 2b`.
- `backreference \# — #1539 Phase 2b`.
- `negated shorthand \W inside [...] — #1539 Phase 2b`.
- `class range out of order`.

## Scope

- Add the missing bytecode/VM support for word-boundary assertions and
  backreferences, or keep narrowed refusals if a smaller native-engine slice
  lands first.
- Reconcile parser behavior for legacy character-class forms that test262
  accepts outside Unicode mode.
- Keep this distinct from Phase 2d Unicode/lookaround work.

## Acceptance Criteria

- Representative boundary/backreference/class compatibility tests pass in
  standalone mode or move to a more precise residual bucket.
- Refusals remain compile-time diagnostics with no JS-host RegExp imports.
- Focused tests cover both pattern parsing and Wasm execution.
