---
id: 2909
title: standalone mapped-arguments [[DefineOwnProperty]] descriptor semantics under fully-native read
area: codegen-standalone
feasibility: hard
status: wont-fix
related: [2908, 1472]
sprint: Backlog
priority: low
horizon: m
---

## Measure-first verdict (2026-07-01, sdev-tail) — NOT REPRODUCIBLE, closing wont-fix

Re-measured on a tree that **includes #2908** (fix commit `005e92a6b` verified an
ancestor of the measured HEAD `a8dba40bc`), i.e. the post-#2908 fully-native
`obj[key]` read is in effect. Ran the whole `language/arguments-object/mapped/**`
corpus (43 files) host-mode vs `--target standalone` via
`runTest262File(..., "standalone")`:

```
CONVERTIBLE (host=pass, standalone=fail) = 0
both-pass  = 39
other      = 4   (all host=fail AND standalone=fail — pre-existing gaps that
                  affect HOST too, so not standalone-specific)
```

Every host-passing mapped-arguments test **also passes standalone**. The
env-import leak is likewise gone: the whole `mapped/**` dir compiles **host-free**
(`leaky=0` — zero `env::` imports in the emitted module). The specific descriptor
test this issue cited,
`nonconfigurable-nonwritable-descriptors-set-by-arguments.js`, is **both-pass**
(host=pass, sa=pass). The 4 `other` files
(`enumerable-configurable-accessor-descriptor.js`,
`nonconfigurable-descriptors-define-failure.js`,
`nonwritable-nonenumerable-nonconfigurable-descriptors-set-by-define-property.js`,
`writable-enumerable-configurable-descriptor.js`) fail **identically** in host and
standalone — a host-mode gap, out of scope for a standalone-specific issue.

**Conclusion:** the predicted pass→host-free-fail flip (#2908 exposing a native
mapped-arguments `[[DefineOwnProperty]]`/mapping-removal gap) does **not**
reproduce on current main — #2908 as-merged did not regress these tests. There is
nothing to convert. Closing `wont-fix`; re-file with a concrete
host-pass/standalone-fail repro if one surfaces.

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
