---
id: 2727
title: "Top-level (sloppy script) `this` should be the global object (typeof this === 'object')"
status: ready
created: 2026-06-26
updated: 2026-06-26
priority: low
feasibility: hard
task_type: bugfix
area: codegen
goal: test262-conformance
sprint: Backlog
depends_on: []
---
# #2727 — top-level sloppy-script `this` = global object

Split out of **#1846** (descoped). This is the single remaining failing
assertion in `test/language/expressions/typeof/built-in-exotic-objects-no-call.js`
— every `typeof new X()` case already returns `"object"` correctly on current
main.

## Problem

In a **non-strict (sloppy) script**, the top-level `this` is the global object,
so `typeof this === "object"`. test262 runs these as scripts, not modules.

Our pipeline wraps each test body into an exported `test()` function. Inside that
(strict module) function, `this` is `undefined`, so `typeof this` evaluates to
`"undefined"` instead of `"object"`.

Verified on current main:

```ts
export function test(): string { return typeof this; }   // → "undefined" (want "object")
```

## Failing test262 (baseline 2026-06-26)

- `test/language/expressions/typeof/built-in-exotic-objects-no-call.js` — assert
  #1 `typeof this === "object"` (all other asserts in the file already pass).

## Root cause

We model every compilation unit as a strict module; there is no notion of a
sloppy-script top-level `this` bound to a global object. The test-harness wrapper
turns the script body into a strict function whose `this` is `undefined`.

## Possible directions (need design — feasibility: hard)

- **Harness-level**: bind the wrapper's `this` to a global-like object for tests
  flagged as flat/sloppy scripts (narrow, but a harness hack, not a compiler
  fix).
- **Compiler-level**: model a top-level (script-mode) `this` that resolves to a
  global object value. Broad semantics change — touches `this` resolution and a
  global-object representation. Should be specced before implementation.

## Notes

Low movement (single assertion). Parked in Backlog until the global-object /
script-mode-`this` semantics are designed. Do NOT attempt as a one-off.
