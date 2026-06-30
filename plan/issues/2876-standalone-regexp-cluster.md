---
id: 2876
title: "Standalone: RegExp cluster (125 host-pass/standalone-fail, de-masked from #2862)"
status: in-progress
assignee: ttraenkler/sr-reflect
created: 2026-06-30
priority: high
task_type: bug
area: codegen
goal: standalone
sprint: current
horizon: l
related: [2860, 2870, 2862, 682, 2885]
umbrella: 2860
blocked_on: 2885
---

> **Blocked on #2885** (standalone descriptor-reflection core). ~70 of the 125
> fail via `Object.getOwnPropertyDescriptor(RegExp.prototype, <accessor>)` →
> undefined → `.get` deref TypeError — the builtin-proto intrinsic-accessor
> reflection defect specced in #2885. Land #2885's core (PR1+PR2) first.

# Standalone: RegExp.\* failures (de-masked)

## Problem

~**125** `built-ins/RegExp/**` tests are host-pass but standalone-fail, de-masked
by #2870 from the phantom ToPrimitive signature (#2862).

## Representative repro

```js
// test/built-ins/RegExp/prototype/global/this-val-regexp-prototype.js
var get = Object.getOwnPropertyDescriptor(RegExp.prototype, "global").get;
assert.sameValue(get.call(RegExp.prototype), undefined);
```

`getOwnPropertyDescriptor(RegExp.prototype, 'global').get` → getter-reflection on
`RegExp.prototype` accessor members; standalone throws a Wasm exception.

## Root cause (to triage)

Standalone RegExp reflection (`.source`/`.flags`/`.global`/`.sticky`/… getters)
over `RegExp.prototype` is the established #1914 surface; the accessor-descriptor
`.get` reflection + brand-checked invocation on the prototype object is not fully
materialised standalone. Overlaps the dual RegExp backend (#682) and native-proto
glue. Triage with `runTest262File(file, cat, undefined, "standalone")`.

## Test plan

Standalone fail → pass, verify-first, full `merge_group` + standalone high-water.
`ctx.standalone` only.

## Triage (sr-reflect, 2026-06-30 — on top of #2885 PR #2371)

Ran the accessor-reflection subset (`RegExp/prototype/{global,ignoreCase,multiline,
dotAll,sticky,unicode,source,flags,hasIndices}/*`, 90 files) via
`runTest262File(f, "smoke", _, "standalone")` with #2885's descriptor-reflection
core applied. Buckets: **28 pass · 48 fail · 8 cross-realm-threw · 6 compile_error**.
(On main, before #2885, the gOPD-based ones errored with the deref-undefined trap.)

The 48 fails are dominated by ONE root cause, plus two smaller ones:

1. **DOMINANT LEVER — reflective `.call` on the opaque descriptor-retrieved closure
   (#2193 territory).** `var get = Object.getOwnPropertyDescriptor(RegExp.prototype,
"global").get; get.call(R)` returns `undefined` for **every** `R` — the getter
   closure body is NEVER invoked. `get` is an opaque `externref` (a `$fn_wrap`
   pulled out of the descriptor `$Object`), so `tryEmitNativeProtoReflectiveCall`
   (`calls.ts:967`) — which recovers brand+member from the _receiver's TS symbol_ —
   can't fire, and the generic `.call` path drops `thisArg` (the legacy
   #2193 drop-thisArg fallback → returns the closure's default `undefined`). This
   blocks ~30 of the 48: every `this-val-non-obj.js` / `this-val-invalid-obj.js`
   (need TypeError throw), `source/value*.js`, `flags/coercion-*.js`,
   `flags/get-order.js`, the `S15.10.7.x_A8/A9/A10` + `15.10.7.x-2` set, and
   `{source,flags}/this-val-regexp-prototype.js`.
   - **Fix direction:** make the generic `.call`/`.apply` path, when the receiver
     is a runtime `$fn_wrap` of a `nativeProtoReceiverClosureStructTypes`-tracked
     struct (extend the tracking to getters), thread `arg[0] → param 1 (this)` and
     `call_ref` the funcref — i.e. recover the closure from the VALUE at runtime
     (ref.test/ref.cast the wrapper), not from a static symbol. This is the shared
     lever for #2876 + #2875 + #2872 (all three clusters' gOPD getters need it).

2. **`get.name === "get <acc>"` on the opaque closure (×9 `name.js`).** #2885 set
   `nativeClosureMeta[funcIdx].name = "get <member>"`, but that meta is only
   consulted at STATIC closure-value `.name` sites; a descriptor-retrieved
   `externref` resolves `.name` through the dynamic function-name path, which
   returns `null`. Needs the dynamic `.name`/`.length` reflection to consult the
   native-closure meta by the wrapper's funcref identity.

3. **SECONDARY correctness — `source`/`flags` proto-identity values.** #2885's
   getter proto-identity arm returns `undefined` uniformly. Spec-correct for the
   boolean flag getters (§22.2.6.5 `get global` etc. → `undefined`), but **WRONG**
   for `source` (§22.2.6.13 → `"(?:)"`) and `flags` (§22.2.6.4 → `""`) on the proto.
   Fix in `emitRegExpProtoMemberBody`: pass member-specific `undefinedResult`
   instrs to `emitNativeProtoIdentityReturnUndefined` (push the native string
   `"(?:)"` / `""` → externref for source/flags; `ref.null.extern` for booleans).
   NB: this only becomes observable once lever (1) lands (the body must actually be
   invoked via `.call`).

**Sequencing:** depends on #2885 (PR #2371) merging first. Lever (1) is the large,
shared piece; (2) and (3) are smaller follow-ons gated behind it.
