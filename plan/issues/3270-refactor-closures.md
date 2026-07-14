---
id: 3270
title: "refactor(codegen): break down + DRY closures.ts god-file (behaviour-preserving)"
status: in-progress
sprint: current
priority: high
feasibility: medium
model: opus
task_type: refactor
subtask_of: 3182
area: codegen
assignee: ttraenkler/sendev-closures
---

# refactor(codegen): break down + DRY `src/codegen/closures.ts`

## Problem

`src/codegen/closures.ts` is a ~5145 LOC god-file mixing several cohesive
subsystems (lexical/free-variable scope analysis, host-vs-GC callback
classification, funcref-wrapper type registry, method-ABI trampolines,
funcref-as-closure wrapping, lifted-param defaults + destructuring) plus a
substantial amount of copy-pasted instruction-emission idioms.

## Scope

Behaviour-preserving GOD-FILE breakdown + DRY cleanup. Two levers:

1. **EXTRACTION** — pull cohesive function groups into new sibling modules
   under `src/codegen/closures/`:
   - `scope-analysis.ts` — AST free-variable / lexical-scope predicates + collectors
   - `callback-classification.ts` — host-vs-GC callback decision + allowlists
   - `funcref-wrapper-types.ts` — funcref-wrapper struct/func-type registry
   - `method-trampolines.ts` — method-ABI→closure-ABI trampoline machinery
   - `funcref-as-closure.ts` — memoized nested-fn-declaration closure wrapping
   - `param-init.ts` — lifted-param defaults + binding-pattern destructuring
   `closures.ts` keeps a re-export barrel so external importers are unaffected.

2. **DRY DEDUP** — factor genuinely-repeated emission idioms into shared
   helpers (binding-default sentinel dispatch, `__extern_is_undefined`
   ensure+flush, null-guarded splice tail, capture-field builder,
   default-return-value tail, lazy closure-cache access, own-locals set,
   collect-over-body).

## Acceptance

- `npx tsx scripts/prove-emit-identity.mjs check` prints **IDENTICAL** (39/39
  file,target across gc/standalone/wasi) — emitted Wasm byte-for-byte unchanged.
- `npx tsc --noEmit` stays at 0 errors.
- Relocation-shift ratchets green (loc-budget / oracle-ratchet / coercion-sites
  / dead-exports / verdict-oracle-bump), with per-issue frontmatter allowances
  as needed (never whole-tree baseline edits, #3131).
- Smoke test `tests/issue-3270.test.ts` compiles programs exercising the touched
  closure/callback/param-default paths.

## Implementation Notes

(See PR — WHY notes recorded inline as extractions/dedups land.)
