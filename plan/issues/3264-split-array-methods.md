---
id: 3264
title: "Split array-methods.ts — extract Array.prototype-borrow subsystem into array-prototype-borrow.ts"
status: done
sprint: 72
priority: high
feasibility: medium
model: opus
task_type: refactor
subtask_of: 3182
area: codegen
assignee: ttraenkler/sendev-array-split
created: 2026-07-14
completed: 2026-07-14
# Relocation-shift ratchet allowances for the NEW destination module (#3131 hatch).
# This PR is a VERBATIM move (byte-identity IDENTICAL across 39 gc/standalone/wasi
# emits) — every flagged "growth" in array-prototype-borrow.ts is a call-site
# RELOCATED out of array-methods.ts, so total repo usage is conserved. Granting
# the change-scoped frontmatter allowance (never a whole-tree baseline edit).
loc-budget-allow:
  - src/codegen/array-prototype-borrow.ts
coercion-sites-allow:
  - src/codegen/array-prototype-borrow.ts
oracle-ratchet-allow:
  - src/codegen/array-prototype-borrow.ts
---

# Split `array-methods.ts` — extract the `Array.prototype.<m>.call(arrayLike,…)` borrow subsystem

## Scope

`src/codegen/array-methods.ts` is a ~10k-LOC god file. Extract the cohesive
`Array.prototype.<method>.call(arrayLike, …)` **prototype-borrowing** subsystem
(a single verbatim, contiguous block) into a NEW sibling module
`src/codegen/array-prototype-borrow.ts`. Pure behaviour-preserving move — NO
logic changes.

Symbols moved (13):

- `ARRAY_LIKE_METHOD_SET`, `ARRAY_LIKE_SEARCH_METHODS`,
  `ARRAY_LIKE_THISARG_METHODS`, `STANDALONE_UNSUPPORTED_ARRAY_LIKE_METHODS`
- `standaloneArrayLikeMethodRefused`
- `compileArrayLikePrototypeCall`, `compileArrayLikePrototypeSearch`
- `compileArrayPrototypeCall` (single entry that recognises the
  `Array.prototype.METHOD.call(obj,…)` AST shape and dispatches)
- `compileArrayPrototypeIndexOf`, `compileArrayPrototypeIncludes`,
  `compileArrayPrototypeEvery`, `compileArrayPrototypeSome`,
  `compileArrayPrototypeForEach`

The rest of `array-methods.ts` compiles real WasmGC array/vec receivers
(`arr.method()`); this group compiles the borrowed-prototype-on-array-like
path. The boundary is one-directional and contiguous: nothing in the rest of
`array-methods.ts` references any of the 13 group symbols (only a comment), so
the move is zero circular-init risk. The group references 6 same-file symbols
back (`ARRAY_METHODS`, `compileArrayMethodCall`, `resolveArrayInfo`,
`emitReceiverNullGuard`, `guardedFuncRefCastInstrs`,
`nativeStringElementEqInstrs`), imported back from `array-methods.ts` (which
gains `export` on the 4 that were file-private). `array-methods.ts` re-exports
the two public entries (`compileArrayPrototypeCall`,
`compileArrayLikePrototypeCall`) so external importers keep resolving.

## Acceptance

- `npx tsc --noEmit` → 0 errors.
- `npx tsx scripts/prove-emit-identity.mjs check` → **IDENTICAL** (39/39
  file×target emits across gc/standalone/wasi). This is the behaviour gate.
- All relocation-shift ratchets green (loc-budget, oracle-ratchet,
  coercion-sites, dead-exports, verdict-oracle) — per-issue frontmatter
  allowances for the destination file where a gate reports a false-positive
  relocation shift (byte-identity IDENTICAL is the proof usage is conserved).
- Smoke test `tests/issue-3264.test.ts` compiling a program that exercises the
  moved subsystem passes.

Part of the #3182 god-file-split epic.

<!-- relocation-shift ratchet allowances (byte-identity IDENTICAL proves conserved usage) -->
