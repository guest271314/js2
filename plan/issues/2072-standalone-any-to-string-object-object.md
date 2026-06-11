---
id: 2072
title: "standalone: String(any-boxed primitive) returns '[object Object]' — $__any_to_string doesn't recognize the boxed shape from String()/pop/catch paths"
status: ready
sprint: 61
created: 2026-06-11
updated: 2026-06-11
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: type-coercion
goal: host-independence
related: [1836, 1470]
origin: "2026-06-11 standalone spec audit (fable agent): verified on main @ 6bf881a0c, target standalone"
---

# #2072 — anyref unboxing missing in standalone String()

## Problem

```ts
const v: any = 42;  String(v)   // standalone: "[object Object]"   node: "42"
const u: any = undefined; String(u)  // "[object Object]" vs "undefined"
String(a.pop())                      // "[object Object]" vs "3"
```

Also `e.name` after catch and `String()` of property-read results. Direct
concat `"n:" + v` works — only the String()/read-result paths fail.

## Root cause

`src/codegen/native-strings.ts:5417-5582` — `$__any_to_string`
tag-dispatches on `$AnyValue`, but the boxed shape produced for
String(anyref) / pop-return / catch-binding values isn't recognized and
falls to the "[object Object]" else-arm (:5470/:5582).

## Fix direction

Normalize all any-producing paths to the `$AnyValue` shape
`$__any_to_string` expects, or teach it the second shape (ref.test chain).

## Acceptance criteria

- All repros match Node in standalone mode; host mode unchanged
- Concat paths unaffected

## Dupe check

#1759 (done, WASI bridge), #1836 (number↔string formatting only), #1470 —
none cover anyref unboxing in String(). New.
