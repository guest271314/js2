---
id: 2122
renumbered_from: 1955
title: "String.fromCharCode/fromCodePoint silently drop all arguments after the first (host backend; native fromCodePoint too)"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-12
completed: 2026-06-12
priority: high
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: codegen
language_feature: string-methods
goal: core-semantics
related: [1598]
origin: "2026-06-10 deep-audit sweep (strings agent): verified miscompile on main"
---

# #2122 — variadic fromCharCode/fromCodePoint compiled as 1-arg

## Problem

`String.fromCharCode(104, 105, 33)` returns `"h"` — arguments after the first
are dropped, not even evaluated for side effects (a side-effect counter in arg
2 stays 0). Same for `fromCodePoint` (host AND native paths).

## Repro (verified on main, default JS-host backend)

```ts
export function test(): string { return String.fromCharCode(104, 105, 33); }
// also: String.fromCodePoint(97, 0x1F600)
```

| call | wasm | node |
|------|------|------|
| `fromCharCode(104,105,33)` | `"h"` | `"hi!"` |
| `fromCodePoint(97, 0x1F600)` | `"a"` | `"a😀"` |

nativeStrings `fromCharCode` multi-arg is correct (has a concat loop); native
`fromCodePoint` also compiles only `arguments[0]`.

## Root cause

`src/codegen/expressions/calls.ts:3506-3526` — host path compiles only
`expr.arguments[0]` and calls the 1-arg `String_fromCharCode` import; same
shape for `fromCodePoint` at calls.ts:3548-3557; the *native* `fromCodePoint`
branch at calls.ts:3537-3546 also takes only arg 0 (unlike the native
`fromCharCode` branch at 3493-3501 which loops).

## Fix direction

Mirror the native `fromCharCode` multi-arg concat loop on all four paths, or
add variadic host imports taking a vec.

## Acceptance criteria

- Both repros match Node on both backends
- Side effects in later args evaluated exactly once, in order
- Surrogate-pair emission for non-BMP code points correct

## Dupe check

#1598 (`fromCharCode` standalone, in-review) covers the standalone/native
helper only; host-mode dropping untracked. Greps for
`fromCharCode`/`fromCodePoint` found no argument-dropping issue.

## Resolution (2026-06-12)

Fixed in `src/codegen/expressions/calls.ts`. The native `fromCharCode` branch
already looped over the args and joined via `__str_concat`; the other three
paths compiled only `arguments[0]`. Added the same per-argument loop to:
1. **host `fromCharCode`** — call the 1-arg `String_fromCharCode` import per
   argument and join with the js-string `concat` import;
2. **native `fromCodePoint`** — call `__str_fromCodePoint` per argument and join
   with `__str_concat`;
3. **host `fromCodePoint`** — same shape as (1) with `String_fromCodePoint`.

Arguments are still compiled left-to-right exactly once. The native marshal /
return-type handling is unchanged.

### Test Results

`tests/issue-2122.test.ts` (5 cases, all PASS):

| case | result |
|------|--------|
| host `fromCharCode(104,105,33)` | "hi!" ✓ |
| host `fromCodePoint(97, 0x1F600)` | "a😀" ✓ |
| host fromCharCode side-effect count (eval once, in order) | 3 ✓ |
| native fromCharCode multi-arg length/charCodeAt | 3 / 33 ✓ |
| native fromCodePoint multi-arg + surrogate pair | length 3, cc0 97, cc1 0xD83D ✓ |

`tsc --noEmit` clean; `tests/issue-1598.test.ts` green (9/9). Pre-existing
failure in `tests/string-methods.test.ts` (imports a missing `./helpers.js`) is
unrelated — a module-resolution error independent of this change.
