---
id: 3254
slug: string-requireobjectcoercible
title: "Standalone: RequireObjectCoercible + ToString for borrowed String.prototype.<m>.call receiver"
status: ready
reopened: 2026-07-31
assignee: opus-tabrand
sprint: current
priority: high
horizon: m
feasibility: hard
goal: standalone-mode
umbrella: 1781
loc-budget-allow:
  - src/codegen/string-ops.ts
  - src/codegen/expressions/calls.ts
---

## REOPENED 2026-07-31 — false-`done` on this issue's own headline method

This was `status: done` (completed 2026-07-13) while **`trim`, the method it is
named after, is still broken**. The text below claims _"the fix generalises
beyond trim"_ and cites _"the ~76 `assert.throws(TypeError, …)` trim-family
tests"_. Measured, it generalised to the **other** methods and left `trim` itself
on the pre-fix `$__any_to_string` `"[object Object]"` terminal.

`runTest262File` on the same file, both lanes, with spec-invariant controls
(`Object.keys({a:1,b:2}).length===2`, `"ab".toUpperCase()==="AB"`,
`String(new Boolean(false))==="false"`) **all passing**:

```
                                            host      standalone
String.prototype.trim.call(new Boolean(false))  [false]   [[object Object]]
String.prototype.trim.call(new Number(123))     [123]     [[object Object]]
String.prototype.toUpperCase.call(new Number(123))  123   123          <- works
```

So the ROC/throw half landed for `trim` and the **`ToString` half did not**,
while both halves landed for the other methods. ~10 ES5 standalone rows in the
`built-ins/String/prototype/trim` family are still failing on it.

Reopened rather than left `done`: a falsely-**open** issue gets caught by the
TaskList reconciler, but nothing detects a falsely-**closed** one, so it stays
invisible indefinitely. `sprint: current` puts it back on the TaskList where it
can be claimed. Whoever lands the `trim` half flips this back to `done`.

Related: #3877 (the assigned-method form, a distinct defect in the
`__proto_method_*` wrapper).

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
