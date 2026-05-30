---
id: 1749
title: "Array spread `[...arr]` / spread-call must honor overridden Array.prototype[Symbol.iterator]"
status: ready
created: 2026-05-30
updated: 2026-05-30
priority: low
feasibility: medium
task_type: feature
area: codegen, runtime
language_feature: array-object-identity, spread, iterator-protocol
goal: object-representation
sprint: Backlog
related: [1719, 1320]
parent: 1719
---

# #1749 — Spread must drive the (possibly overridden) Array iterator

## Problem

Split out of #1719 (CPR — Compiled Prototype Record). The #1719 work landed the
read-drive for all four **destructuring** contexts (declaration, for-of-head,
parameter, assignment) so array destructuring now honors a monkeypatched
`Array.prototype[Symbol.iterator]` / `Array.prototype.values` override. **Spread**
(`[...arr]`, `f(...arr)`, `new C(...arr)`) is a separate consumer of `GetIterator`
and was NOT part of the 71 `*-iter-val-array-prototype.js` destructuring fails, so
it was deliberately left out of the #1719 PRs.

Spread over an array whose prototype iterator is overridden still takes the static
backing-store fast path and ignores the override — same root cause as #1719, but a
different emit site.

## Why this is genuinely out of the original 71

The 71 tests #1719 closed are all array-**destructuring** patterns. Spread is a
distinct grammar production with its own codegen path; none of the 71 exercise it.
This is tracked as a follow-up, not a regression.

## Fix direction

Reuse the already-proven CPR read-drive helper
`emitArrayProtoIteratorDrive` (`src/codegen/expressions/proto-override.ts`) at the
spread-element emit site, gated identically behind
`ctx.arrayIteratorMaybeOverridden && arrayIteratorOverrideGlobalIdx(ctx) !== undefined`.
The drive yields an iterator externref; drain it with `__iterator_next` collecting
elements into the spread target (array literal build / call-argument vector). The
gate keeps override-free modules byte-identical, exactly as the four dstr contexts do.

## Acceptance

- `Array.prototype[Symbol.iterator] = function*(){ yield 42 }; const a = [...[1,2,3]];`
  → `a` reflects the override, not `[1,2,3]`.
- Override-free spread emits byte-identical Wasm (no regression on
  `tests/equivalence.test.ts`).

## Source

Carved from #1719 "CPR-2 remaining" follow-up list (see #1719 issue file, CPR
completion section). The #1719 destructuring cluster is done; this is the next
incremental consumer.
