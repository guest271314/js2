---
id: 2677
title: "fnctor/class ctor chained this-assignment drops non-outermost fields (this.a = this.b = expr → b missing from struct)"
status: done
assignee: ttraenkler/sd-2038
completed: 2026-06-25
sprint: 66
created: 2026-06-25
updated: 2026-06-25
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: classes, constructors
goal: correctness
related: [2674, 2664]
origin: "Discovered while tracing the acorn 9th wall (#2674): compileNewFunctionDeclaration's collectThisAssignments only recorded the OUTERMOST LHS of a constructor this-assignment, dropping inner chained targets. A GENERAL bug (any chained ctor this-assignment), carved out of #2674 as its own tracked correctness win. Fixed in PR #2072 (commit titled fix(#2674) — discovery context)."
---

# #2677 — fnctor/class ctor chained `this`-assignment drops non-outermost fields

## Problem

A function-constructor (fnctor) `var P = function(){ … }` whose body uses a
CHAINED `this`-assignment — `this.a = this.b = this.c = expr` — only registered a
WasmGC struct field for the **outermost** LHS (`a`). The inner targets (`b`, `c`)
were dropped: `compileNewFunctionDeclaration`'s `collectThisAssignments`
(`src/codegen/expressions/new-super.ts`) matched a statement-level
`this.<field> = <value>` and treated the entire RHS (`this.b = this.c = expr`) as
an opaque "value", never recursing into it.

Result: the fnctor struct is missing the inner-target fields. A later READ of one
(`p.b`) falls through to the `__extern_get` sidecar → `undefined`, or the WRITE
lands in the sidecar instead of the slot — read/write divergence and silent
wrong values.

Surfaced concretely by acorn's Parser ctor (`this.start = this.end = this.pos`,
`this.startLoc = this.endLoc = …`, `this.lastTokStart = this.lastTokEnd = …`,
`this.yieldPos = this.awaitPos = this.awaitIdentPos = 0`), which left
`$__fnctor_Parser` missing `end`/`endLoc`/`lastTokEnd`/`lastTokStartLoc`/
`awaitPos`/`awaitIdentPos`. General bug, not acorn-specific.

## Fix (LANDED — PR #2072)

`collectAssignmentChain` walks the full `=` chain, recording every `this.<field>`
LHS (outer + all chained inner targets), inferring each field's type from the
value flowing into it.

## Verification

`tests/issue-2674-chained-this-assignment-fnctor-fields.test.ts` (4/4):
`this.a=this.b=this.c=5` reads back 15; `this.start=this.end=7` → `end` reads 7;
a 3-deep null/number chain reads every inner target. WAT shows `$__fnctor_Parser`
with the full field set. tsc + prettier + biome + coercion-sites gate clean.
Broad-impact (struct field-collection) → validated via the merge_group floor.

## Note

This fix is NECESSARY but NOT SUFFICIENT for the acorn 9th wall (#2674) — the
remaining cause there is the read-side dispatch compile-order candidate freeze
(symmetric to #2664's write side), fixed separately by a `__get_member_<name>`
deferred-fill under #2674.
