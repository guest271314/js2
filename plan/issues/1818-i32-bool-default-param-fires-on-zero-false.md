---
id: 1818
title: "i32/boolean parameter default fires on a legitimate 0 / false argument"
status: blocked
escalation: needs-architect-spec
created: 2026-06-04
updated: 2026-06-04
priority: high
feasibility: hard
task_type: bugfix
area: codegen
goal: correctness
sprint: 59
---
# #1818 — i32/boolean parameter default fires on `0` / `false`

## Symptom
- `function f(b=true){return b}; f(false)` → `true`.
- `function f(n:number=5){return n}; f(0)` (n narrowed to i32) → `5`.

## Location
`src/codegen/closures.ts:767-770` and `src/codegen/class-bodies.ts:1076-1083`
use `i32.eqz` as the "argument missing" sentinel; booleans resolve to i32
(`type-mapper.ts:55`). The f64 path correctly uses a NaN self-test, and the
array/object-pattern paths already *skip* the check for i32 (closures.ts:714).

## Spec
Default applies only when the argument is `undefined`.

## Fix
Don't emit a default check for plain i32/boolean params; thread an explicit
arg-present flag instead of reusing `0` as the missing sentinel.

## Investigation (2026-06-04, dev-t2) — [ESCALATED-NEEDS-ARCHITECT]

Reproduced; the defect is **broader and more systemic than a localized
`i32.eqz` swap** — missing-argument signalling is inconsistent across function
forms AND value types. Matrix (target wasi, nativeStrings):

| form                | arg = falsy (`false`/`0`) | arg omitted `f()` |
|---------------------|---------------------------|-------------------|
| boolean export fn   | 0 OK                      | **0 WRONG** (default not applied; want 1) |
| boolean arrow       | **1 WRONG** (default fired)| 1 OK             |
| boolean method      | **1 WRONG** (default fired)| (n/t)            |
| i32-native export fn| 0 OK                      | 5 OK             |
| f64 export fn       | 0 OK                      | **NaN WRONG** (default not applied; want 5) |
| f64 arrow           | 0 OK                      | **0 WRONG** (default not applied; want 5) |

Two independent defects, not one:
1. **Inline check fires on a falsy value** (arrow/method i32/boolean):
   `emitParamDefaultCheckInline` (`closures.ts:767-770`) uses `i32.eqz`, which
   cannot distinguish a real `0`/`false` from a missing-arg pad. i32 has **no
   spare sentinel** — every i32 is a legitimate argument — so a value-sentinel
   is fundamentally impossible; an explicit arg-present signal is required.
   (`pushParamSentinel` in `type-coercion.ts:2346` falls to `pushDefaultValue`
   → `i32.const 0` for i32, confirming the collision.)
2. **Omitted-arg default not applied** (export-fn / some f64 paths): the no-arg
   call site does not reliably fill the slot with the missing sentinel, so the
   callee's check never fires (or the f64 sNaN sentinel `0x7FF00000DEADC0DE`
   isn't the value padded — `f64 arrow f()` returns 0, not NaN).

The existing reliable signal is the `__argc` global
(`statements/nested-declarations.ts:1016`), but it is **only set by call sites
when the callee uses `arguments`** (`calls.ts:1106`), so it can't be relied on
for the default check today. The correct fix makes the calling convention carry
a reliable arg-present/arg-count signal for **every** call to a defaulted
function (set `__argc` unconditionally when the callee has defaulted params, and
gate i32/boolean/f64 defaults on `__argc <= paramOrdinal`), threaded across the
direct-call, closure/call_ref, and method-dispatch paths — spanning `calls.ts`,
`closures.ts`, `class-bodies.ts` and the f64 sentinel path. Broad regression
surface on every defaulted function.

**Recommendation: architect spec for the arg-present calling-convention design
before implementation.** The localized "swap i32.eqz" fix the issue proposed
fixes defect #1 for arrows/methods but leaves defect #2 broken and risks
regressing the currently-correct i32-native and f64-export paths. No code change
landed; findings only.

