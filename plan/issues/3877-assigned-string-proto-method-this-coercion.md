---
id: 3877
slug: assigned-string-proto-method-this-coercion
title: "Standalone: assigned String.prototype method on a non-string `this` returns null"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: high
horizon: l
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen, string-ops
language_feature: this-coercion
goal: standalone-mode
sprint: current
es_edition: es5
related: [1781, 3254]
---

# #3877 — `obj.m = String.prototype.m; obj.m()` on a non-string `this`

## Problem

ES5 §15.5.4.x: every `String.prototype` method performs
`ToString(CheckObjectCoercible(this))`. Under `--target standalone`, assigning a
`String.prototype` method onto a non-string object and invoking it as a method
returns **`null`** instead of operating on the coerced receiver.

```js
var b = new Boolean();
b.toUpperCase = String.prototype.toUpperCase;
b.toUpperCase(); // host "FALSE"  ·  standalone null
```

## The property round-trip is NOT the problem

Twin control, both lanes, same file:

```
standalone: typeof=function  identity=true  hasOwn=true
            String(b)="false"  toUpperCase.call(b)="FALSE"  b.toUpperCase()=null
```

`typeof`, `===` identity against `String.prototype.toUpperCase`, and
`hasOwnProperty` are all correct. `ToString` on the receiver is correct. The
`.call()` form on the **identical receiver** is correct (that is #3254). Only
the assigned-method invocation fails.

## Measured per-method matrix

Receiver `new Number(1234)` (`ToString` → `"1234"`), every method invoked as an
assigned own property. Harness: `runTest262File(abs, cat, 60000)` and
`(…, "standalone")` on the same file (`.tmp/probe-3877-matrix.js`).
**Controls `Object.keys({a:1,b:2}).length===2`, `"ab".toUpperCase()==="AB"`,
`String(new Boolean(false))==="false"` all pass on both lanes**, so these
readings are load-bearing (per #3885).

| method        | host    | standalone |
| ------------- | ------- | ---------- |
| `substring`   | `23`    | `23` ✅    |
| `charAt`      | `2`     | `2` ✅     |
| `toUpperCase` | `1234`  | **`null`** |
| `toLowerCase` | `1234`  | **`null`** |
| `slice`       | `23`    | **`null`** |
| `charCodeAt`  | `49`    | **`null`** |
| `indexOf`     | `1`     | **`null`** |
| `lastIndexOf` | `1`     | **`null`** |
| `trim`        | `1234`  | **`null`** |
| `concat`      | `1234X` | **`null`** |
| `split`       | `2`     | **`0`**    |

**9 of 11 broken; `substring` and `charAt` already work.** As with
`Array.prototype` in #3876, a working reference exists in-tree — the fix is
very likely to route the other nine the way those two already go, rather than
to invent a mechanism.

## This supersedes the original framing — read before implementing

This issue was opened on the diagnosis _"the §22.1.3 preamble is applied at the
borrowed `.call()` site (`emitBorrowedStringReceiverToString`, #3254) but not at
assigned-method dispatch."_ That is **incomplete**: `substring` and `charAt`
reach the correct answer through the same nominal assigned-method dispatch, so
"the dispatch site has no preamble" cannot be the whole cause. The real question
is why those two coerce and the other nine do not.

Starting point: `compileNativeStringMethodCall`'s `emitReceiver`
(`src/codegen/string-ops.ts`) already handles two receiver shapes — externref →
native string, and a concrete object struct ref → `tryStructToString` (the
§22.1.3 ToString dispatch). Establish first **whether the nine even reach
`compileNativeStringMethodCall`**, or whether they are compiled as a generic
dynamic method call that never consults it. Do not assume; the matrix above says
the two paths diverge somewhere and the divergence has not yet been located.

### Dead end already excluded — do not repeat it

`src/codegen/expressions/call-receiver-method.ts` (~line 2311) guards the
guarded-native-string fast path with

```ts
!(propAccess.name.text === "substring" && sourceHasMethodReassignment(ctx, propAccess.expression, "substring")) &&
```

This looks exactly like the cause: `sourceHasMethodReassignment` is already
generic in `methodName` and only the **call site** is hard-coded to
`"substring"` — the one method that works. **It is not the cause.**

Generalising it to
`!sourceHasMethodReassignment(ctx, propAccess.expression, propAccess.name.text)`
and re-running the matrix produced **byte-identical standalone output** — all
nine still `null`. The conditional block is therefore not being entered for
these calls at all (some earlier predicate in the same `if` — `ctx.nativeStrings`,
`receiverMayBeNativeStringAtRuntime`, or the `STRING_METHODS` name test — already
excludes them), and the `null` originates **downstream in the generic dynamic
method dispatch**, not in the native-string fast path.

The change was reverted rather than shipped: it had no measured effect, so it is
an unproven edit, and it would also widen a perf-relevant bail-out on nothing but
a plausible story. Next investigator should instrument the generic dispatch for
a property-access callee whose value is a `String.prototype` method.

## Sibling defect — #3254 is FALSE-DONE on its own headline method

#3254 (`status: done`, completed 2026-07-13) is titled _"…borrowed
String.prototype.<m>.call receiver"_ and its text claims _"the fix generalises
beyond trim"_, citing _"the ~76 trim-family tests"_. Measured, it generalised to
the other methods and left **`trim` itself** on the pre-fix
`$__any_to_string` `"[object Object]"` terminal. Same probe, controls passing:

```
                                     host      standalone
String.prototype.trim.call(boolObj)  [false]   [[object Object]]
String.prototype.trim.call(numObj)   [123]     [[object Object]]
String.prototype.toUpperCase.call(numObj)  123 123            <- works
```

So `.call()` is fixed for the other methods and **not** for `trim`. #3254's
`status: done` is wrong and should be corrected by whoever lands the `trim`
half. That is a separate ~10 rows from this issue's ~51.

## Size

~51 ES5 standalone rows carry the assigned-method shape (from the
`built-ins/String/prototype` wrong-answer cut of 97). Treat as a **ceiling, not
a flip count** — the matrix shows the shape is method-dependent, so rows using
`substring`/`charAt` are already passing and must not be counted.

## Acceptance criteria

- `obj.m = String.prototype.m; obj.m()` agrees with
  `String.prototype.m.call(obj)` and with the host lane, for every method in
  the matrix above, on a boolean-object, number-object, plain-object-with-
  `toString`, and array receiver.
- A receiver whose `toString` throws propagates that exception
  (§15.5.4.x ToString dispatch), rather than returning `null`.
- `null` / `undefined` receivers throw `TypeError` (RequireObjectCoercible).
- `tests/issue-3877.test.ts` permanently covers the matrix, both lanes.
- Every verification run states **harness, lane, and control outcome** (#3885).
- Any pass-count claim is re-measured per row, not read off the baseline.

## Not in scope

- The `trim`-specific `.call()` hole (see above) — same area, separate fix and
  separate ~10 rows.
- `split` / `concat` "not yet implemented in `--target standalone`" refusals,
  which are a distinct missing-builtin surface.
