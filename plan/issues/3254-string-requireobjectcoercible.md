---
id: 3254
slug: string-requireobjectcoercible
title: "Standalone: RequireObjectCoercible + ToString for borrowed String.prototype.<m>.call receiver"
status: done
completed: 2026-07-13
assignee: opus-tabrand
sprint: 72
priority: high
horizon: m
feasibility: hard
goal: standalone-mode
umbrella: 1781
loc-budget-allow:
  - src/codegen/string-ops.ts
  - src/codegen/expressions/calls.ts
---

## Problem

Under `--target standalone`, the borrowed String-method dispatch
`String.prototype.<m>.call(thisArg, …)` synthesised `recv.<m>()` and leaned on
`compileNativeStringMethodCall`'s default `emitReceiver`, which only handled a
string / object-struct receiver. `.call(false)` / `.call(123)` / `.call(obj)`
fell through to the `$__any_to_string` "[object Object]" terminal, and
`.call(undefined)` (the non-null tag-1 singleton) silently coerced instead of
throwing. The reflective closure body already did RequireObjectCoercible +
ToString, but the `.call()` fast path bypassed it — so the `String.prototype`
trim family and siblings failed their §22.1.3 this-coercion assertions.

## Fix

Adds `emitBorrowedStringReceiverToString` (string-ops.ts): the §22.1.3 preamble
— RequireObjectCoercible(this) (throw TypeError on `null` / the `$undefined`
singleton / a null externref) then ToString(this) via the type-aware native
coercion engine. Wired as a `receiverOverride` in the borrowed-method dispatch
(calls.ts), so it covers every method in `STANDALONE_STR_PROTO_METHODS` (trim
family + charAt / …). This generalises beyond the trim tests to all
`String.prototype.<m>.call(<primitive>)` borrowed receivers.

Standalone-only path; host / gc / wasi lanes untouched.

## Known limitation (not a regression)

A dynamic `any`-typed OBJECT receiver still stringifies through
`__any_to_string` ("[object Object]" terminal) rather than a full ToPrimitive →
ToString chain, so `new Object(42)` / user-object receivers with a custom
`toString` are not yet covered. Pre-existing behaviour — this change does not
regress it. The merge_group standalone floor validates net-positive.

## Attribution

Root-caused and initially implemented by opus-strtrim (commit d44d0d6c);
adopted, main-merged, and landed by opus-tabrand (#3255 window).
