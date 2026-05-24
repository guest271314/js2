---
id: 1323
sprint: 56
title: "$IteratorResult struct: eliminate __iterator_done/__iterator_value host imports (runtime wiring gap)"
status: ready
created: 2026-05-24
updated: 2026-05-24
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: feature+bugfix
goal: host-independence
area: codegen+runtime
language_feature: iterators, for-of
supersedes_pr: 347
---
# #1323 — $IteratorResult struct (runtime wiring gap)

Replace the `__iterator_done` / `__iterator_value` host imports with a Wasm-native
`$IteratorResult` struct returned by `__iterator_next`. The original attempt
(PR #347, closed) implemented the codegen side but left a runtime wiring gap that
**regresses conformance** — it must be re-done with the runtime fixed.

## Why PR #347 was closed (root cause — verified by sendev-432-347, 2026-05-24)

PR #347's conflict resolution against current main was clean, but the feature
itself is broken independent of the merge:

- #1323 changed the **legacy codegen path** (`src/codegen/statements/loops.ts`)
  so `__iterator_next`'s result is **unconditionally** `any.convert_extern` +
  `ref.cast` to `$IteratorResult`.
- But the runtime `__iterator_next` (`src/runtime.ts` ~L5904) only returns a real
  `$IteratorResult` struct when it can reach
  `callbackState.getExports().__make_iterator_result`.
- In the **default** `buildImports(imports, undefined, stringPool)` usage — which
  is what the tests (and most callers) use — `callbackState` is absent, so it
  hits the "defensive fallback" that returns the **raw JS object**, which then
  fails the `ref.cast` with a runtime `illegal cast`.
- The fallback's comment ("legacy host-import path still works") is **false**:
  the legacy path was rewritten to require the struct.

**Proven regression:** `tests/iterators.test.ts` (5 string for-of) +
`tests/symbol-iterator-protocol.test.ts` (custom iterable) **PASS on origin/main**
but **FAIL with #1323** (`illegal cast`). Same failures reproduce on the PR's
pre-merge tip — so it's the feature, not the merge.

## What a correct implementation needs

1. **Runtime must construct `$IteratorResult` without depending on `callbackState`** —
   OR the legacy codegen path must keep working (return the raw object / not cast)
   when `__make_iterator_result` is unreachable. Pick one; the cast and the
   constructor must be consistent across all `buildImports` usages, including the
   default (no callbackState) path.
2. **Update the stale test assertions**: `tests/iterators.test.ts:90-91` still
   assert the WAT contains `__iterator_done` / `__iterator_value` — the very
   imports #1323 removes. Update them to assert the struct path.
3. Reconcile with `__iterator_rest` (#1052) in `addIteratorImports` (both-sides-add
   in `src/codegen/index.ts`) — PR #347 already resolved this cleanly (keep both
   the `__iterator_rest` import and the `__make_iterator_result` helper/export;
   `makeFuncIdx` index math stays correct).

## Files
- `src/codegen/statements/loops.ts` — the unconditional cast site
- `src/runtime.ts` ~L5904 — `__iterator_next` / the `callbackState`-dependent
  `__make_iterator_result` reachability + defensive fallback
- `src/codegen/index.ts` — `addIteratorImports` (coexist with `__iterator_rest`)
- `tests/iterators.test.ts`, `tests/symbol-iterator-protocol.test.ts` — fix stale
  assertions + confirm string-for-of / custom-iterable pass

## Acceptance
- `__iterator_done` / `__iterator_value` host imports eliminated.
- `tests/iterators.test.ts` + `tests/symbol-iterator-protocol.test.ts` pass
  (no `illegal cast`) in the **default** buildImports path.
- Stale WAT assertions updated.
- No test262 regression (string for-of currently passes on main — must stay green).

PR #347's clean conflict resolution is preserved at local commit `4b9f14e30` if a
future dev wants the index.ts reconciliation as a starting point.
