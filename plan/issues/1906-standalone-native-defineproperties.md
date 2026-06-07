---
id: 1906
title: "standalone: native Object.defineProperties over $Object descriptors"
status: in-review
sprint: 61
created: 2026-06-07
updated: 2026-06-07
priority: critical
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: objects, property-descriptors
goal: standalone-mode
parent: 1472
related: [1472, 1629, 1631, 1888]
test262_bucket: object-property-semantics
test262_count: 748
claimed_by: codex-developer
claimed_at: 2026-06-07T02:22:54.207Z
pr: 1264
---
# #1906 — Standalone native `Object.defineProperties`

## Problem

The shared object/property semantics bucket still samples:

```text
Codegen error: '__defineProperties' ... not yet supported in --target standalone
```

Single-property descriptor paths have native standalone coverage for important
data/accessor slices, but the plural `Object.defineProperties` helper is still
caught by the broad dynamic object/property refusal.

## Scope

- Implement a standalone-native `__defineProperties` path for `$Object`.
- Iterate the descriptor map using the existing object-runtime enumeration
  helpers.
- Reuse native single-property helpers for data and accessor descriptors rather
  than introducing a second descriptor representation.
- Keep unsupported descriptor shapes fail-loud with this issue cited.

## Acceptance Criteria

- `Object.defineProperties(o, { a: { value: 1 }, b: { get() { ... } } })`
  compiles and runs under `target: "standalone"` for open `$Object` values.
- The helper performs gather/validate before apply where the current descriptor
  runtime supports it, or refuses before partial mutation for unsupported
  shapes.
- No `env::__defineProperties` import is emitted under standalone.
- Existing `Object.defineProperty` data/accessor tests remain green.

## Implementation Notes

- Added a standalone-native `__defineProperties` helper in the open-object
  runtime and routed it through `OBJECT_RUNTIME_HELPER_NAMES` so standalone does
  not refuse or import `env::__defineProperties`.
- The helper enumerates `$Object` descriptor maps with `__obj_ordered`, gathers
  and validates supported `$Object` descriptor records first, then applies them
  through the existing native `__defineProperty_value` and
  `__defineProperty_accessor` helpers.
- Focused tests in `tests/issue-1906.test.ts` use computed keys to force the
  `$Object` runtime path, covering data descriptors, accessor descriptors, and
  pre-apply refusal for unsupported primitive/conflicting descriptors.

## Validation

- `pnpm test tests/issue-1906.test.ts`
- `pnpm test tests/issue-1629-S6.test.ts tests/issue-1629-S3.test.ts tests/issue-1629-S2.test.ts`
- `pnpm exec tsc --noEmit --incremental false`

Revalidated by `codex-developer` on branch `symphony/1906` after merging
`origin/main` at `3827daa96e6b7147a30474c85a065e8b35bafed2`; checks above
pass locally on 2026-06-07.

PR #1264 is open against `main` and the issue remains `in-review` for the
PR-status poller.
