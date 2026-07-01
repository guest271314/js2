---
id: 2909
title: standalone mapped-arguments [[DefineOwnProperty]] descriptor semantics under fully-native read
area: codegen-standalone
feasibility: hard
status: ready
related: [2908, 1472]
sprint: Backlog
priority: low
horizon: m
---

## Problem

Surfaced by #2908. Once the standalone dynamic property read `obj[key]` is fully
host-free (routed to the native `$Object` `__extern_get` rather than the host
import), a bounded set of `language/arguments-object/mapped/*` test262 cases
that manipulate an arguments object's property _descriptors_ flip pass→fail.

Fresh head 20474543f: **23** `arguments-object` tests were leaky-pass (importing
only `env::__extern_get`); with #2908 landed, ~9–13 of them flip pass→fail. They
remain host-free-fail (`host_free_pass` unchanged — no standalone-floor breach),
so this is a follow-up quality gap, not a floor regression.

Example: `nonconfigurable-nonwritable-descriptors-set-by-arguments.js`:

```js
function fn(a) {
  Object.defineProperty(arguments, "0", {configurable: false});
  arguments[0] = 2;
  Object.defineProperty(arguments, "0", {writable: false});
  verifyProperty(arguments, "0", { value: 2, writable: false, enumerable: true, configurable: false });
  a = 3; // mapping already removed → value stays 2
  verifyProperty(arguments, "0", { value: 2, ... });
}
```

## Root cause (to confirm)

The old mixed path — host `__extern_get` VALUE read + native
`defineProperty`/`getOwnPropertyDescriptor` — happened to pass. The
fully-native read exposes that the native `$Object`/arguments representation does
not implement mapped-arguments exotic `[[DefineOwnProperty]]` + mapping-removal
semantics (§10.4.4) the way the host reader's view did. A plain native
`arguments[0]` read works (verified); the gap is specifically the
descriptor-manipulation + `verifyProperty` interaction on a mapped arguments
object.

## Acceptance

The ~9–13 `arguments-object/mapped/*` descriptor tests that #2908 flips to
host-free-fail return to pass, host-free (`host_free_pass` +9–13), with no other
regressions.
