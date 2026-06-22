---
id: 2616
title: "Proxy (host): present-but-non-callable trap is silently dropped instead of throwing TypeError (~19 fails)"
status: ready
sprint: 65
created: 2026-06-22
updated: 2026-06-22
priority: high
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: proxy
goal: spec-completeness
parent: 1355
related: [2180]
test262_bucket: proxy-trap-not-callable
---
# #2616 — Proxy (host): a present non-callable / non-undefined trap must throw TypeError, not be omitted

Slice of #1355. **Host (gc) mode only.** Per §10.5 each internal method does
`trap = GetMethod(handler, "<trapName>")`, and `GetMethod` (§7.3.10) throws a
**TypeError** when the property is present but not callable (it only returns
`undefined` when the value is `undefined`/`null`). Our host bridge instead
*silently omits* a present-non-callable trap, so the host Proxy falls through to
the target and the user's `assert.throws(TypeError, …)` never fires.

## Re-measured evidence (arch, 2026-06-22)

19 host fails of the shape `new Proxy(t, { <trap>: <non-callable> })` then an
operation expecting a TypeError. Examples (all `fail`, returned a value instead
of throwing):
`get/trap-is-not-callable.js`, `get/null-handler.js`,
`apply/trap-is-not-callable.js`, `defineProperty/trap-is-not-callable.js`,
`deleteProperty/trap-is-not-callable.js`,
`getOwnPropertyDescriptor/trap-is-not-callable.js`,
`getPrototypeOf/trap-is-not-callable.js`, `getPrototypeOf/null-handler.js`,
`has/trap-is-not-callable.js`, `ownKeys/trap-is-not-callable.js`,
`set/trap-is-not-callable.js`, `setPrototypeOf/trap-is-not-callable.js`,
`preventExtensions/trap-is-not-callable.js`, `isExtensible/trap-is-not-callable.js`,
`construct/trap-is-not-callable.js` (and the `null-handler` siblings).

Representative test (`get/trap-is-not-callable.js`):
```js
var p = new Proxy({}, { get: {} });
assert.throws(TypeError, function() { p.attr; });
```

## Root cause

`_buildProxyBridgeHandler` (`src/runtime.ts` ~line 5070) builds the host bridge
handler by reading each trap off the user handler struct:

```ts
const rawTrap = _structFieldRaw(handler, name, exports);
if (rawTrap == null) continue;                       // undefined/null → omit (CORRECT: §7.3.10 returns undefined)
const callable = _maybeWrapCallableUnknownArity(rawTrap, callbackState);
if (typeof callable !== "function") continue;        // <-- BUG: present-but-non-callable is silently omitted
```

A present non-callable trap (`{}`, `1`, `"x"`, …) hits the second `continue`,
so the bridge has no `<trap>` method, the host engine uses its default
(ordinary) behavior, and the spec-mandated TypeError never throws.

Note the §7.3.10 *timing* nuance: GetMethod runs *inside each internal method*,
so strictly the TypeError is thrown when the trapped operation is invoked, not at
construction. For the test262 corpus, installing a bridge trap that **throws on
invocation** reproduces the correct observable behavior (the throw happens when
`p.attr` runs, which is exactly when the tests check it).

## Implementation Plan

### Change
**File: `src/runtime.ts`**, `_buildProxyBridgeHandler` (~line 5070).
Replace the silent-omit second `continue` with: install a bridge trap that
**throws a TypeError when invoked**, for a present-but-non-callable trap value.

```ts
const rawTrap = _structFieldRaw(handler, name, exports);
if (rawTrap == null) continue;                       // undefined/null → genuine absence, omit
const callable = _maybeWrapCallableUnknownArity(rawTrap, callbackState);
if (typeof callable !== "function") {
  // §7.3.10 GetMethod: present but not IsCallable → TypeError when the
  // owning internal method runs. Install a throwing bridge trap so the host
  // engine surfaces the TypeError at operation time (matches test262 timing).
  bridge[name] = () => {
    throw new TypeError(`'${name}' on proxy: trap is not a function`);
  };
  continue;
}
```

### Edge cases / correctness
- Distinguish **absent** (`undefined`/`null` → `rawTrap == null` → omit, host
  forwards to target — CORRECT) from **present-non-callable** (→ throwing bridge
  trap). The existing `if (rawTrap == null) continue;` already separates these;
  only the *second* branch changes.
- A Wasm-closure trap that `_maybeWrapCallableUnknownArity` *does* wrap into a
  function stays on the normal path — unchanged.
- The TypeError must be the *host engine's* (so `e instanceof TypeError` holds in
  the compiled program via the exception bridge). Throwing a plain `TypeError`
  inside the bridge trap propagates through the host Proxy MOP and the
  `lastCaughtException` bridge — same path other host-thrown TypeErrors take.
- `construct` / `apply` traps: same fix applies (a non-callable `apply`/`construct`
  must throw when `p(...)` / `new p(...)` runs).

### Test-gate (test262, gc mode)
All `built-ins/Proxy/*/trap-is-not-callable.js` and `*/null-handler.js`
(non-`-realm`, non-`-with`) — ~19 tests. Plus `tests/issue-2616.test.ts`
(`new Proxy(t,{get:{}})` access throws TypeError; absent trap still forwards).

### Risk
Low — localized to the host bridge builder. No codegen change. Validate gc
equivalence + the Proxy directory.
