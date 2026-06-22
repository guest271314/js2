---
id: 2617
title: "Proxy (host): trap-thrown exceptions and §10.5 invariant TypeErrors are swallowed by the boundary try/catch (~40 fails)"
status: ready
sprint: 65
created: 2026-06-22
updated: 2026-06-22
priority: high
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: runtime
language_feature: proxy
goal: spec-completeness
parent: 1355
related: [2180]
test262_bucket: proxy-trap-abrupt-invariant
---
# #2617 — Proxy (host): propagate trap-thrown exceptions and §10.5 invariant TypeErrors through the boundary helpers

Slice of #1355. **Host (gc) mode only.** The boundary helpers
(`__extern_get` / `__extern_set` / `__extern_has` / `__delete_property` /
`__getPrototypeOf` / `__getOwnPropertyDescriptor` / …) wrap their host reads in
a `try/catch` that swallows *all* exceptions except the revoked-proxy one,
falling through to a struct/undefined path. When the host value is a **user
Proxy**, the swallowed exception is exactly what the test wants to observe: a
trap's abrupt completion, or the host engine's §10.5 invariant TypeError. This
is the largest remaining host-mode bucket after the get-read fix (#2615) and the
non-callable fix (#2616).

## Re-measured evidence (arch, 2026-06-22)

Isolated repros (host gc):
```ts
// trap throws → must propagate; currently returns false (0):
const p = new Proxy({}, { has: () => { throw new RangeError("x"); } }); ("a" in p); // RETURNS 0 (BUG: should throw RangeError)
// §10.5.1 invariant: getPrototypeOf trap returning a non-object/non-null → TypeError; currently returns null:
const p = new Proxy({}, { getPrototypeOf: () => 1 }); Object.getPrototypeOf(p); // RETURNS null (BUG: should throw TypeError)
// (trap IS invoked — side effects observed — so the issue is purely result/throw propagation)
```

Affected test262 buckets (gc):
- **`*/return-is-abrupt*.js`** across get/set/has/deleteProperty/defineProperty/
  getOwnPropertyDescriptor/getPrototypeOf/setPrototypeOf/ownKeys/isExtensible/
  preventExtensions/apply/construct — trap throws, must propagate (~15).
- **`assert.throws(TypeError, …)` §10.5 invariant tests** — e.g.
  `getPrototypeOf/not-extensible-not-same-proto-throws.js`,
  `getPrototypeOf/trap-result-neither-object-nor-null-throws-*.js`,
  `getOwnPropertyDescriptor/resultdesc-is-not-configurable-not-writable-targetdesc-is-writable.js`,
  `setPrototypeOf/*`, `defineProperty/*-throws.js` (~25).

## Root cause

Each boundary helper looks like (`__extern_get`, `src/runtime.ts` ~6883;
`__extern_has` ~7132; `__delete_property`, `__getPrototypeOf`,
`__getOwnPropertyDescriptor` similarly):

```ts
try {
  if (Object.getPrototypeOf(obj) !== null && key in Object(obj)) return obj[key];
} catch (e) {
  if (_isRevokedProxyError(e)) throw e;   // <-- ONLY revoked-proxy re-thrown
  /* otherwise fall through to the generic struct path */   // <-- swallows trap throws + invariant TypeErrors
}
```

For a **user Proxy** (tracked in `_userProxies`), any exception from the host
MOP operation is either (a) the user trap's own abrupt completion or (b) the
host engine's §10.5 invariant TypeError — both spec-observable. The catch
swallows them and returns a struct/undefined fallthrough, so the user program
sees a wrong value instead of the throw.

Separately, the §10.5.1 *invariant for getPrototypeOf returning a non-object*
returns `null` rather than throwing because the boundary's `__getPrototypeOf`
helper does not let the host engine run the invariant (it reads via a path that
coerces the bad result to null). See the getProto repro above.

## Implementation Plan

### Core change — re-throw exceptions originating from a user Proxy
**File: `src/runtime.ts`** — in each boundary helper's `catch (e)`, broaden the
re-throw: if `obj` (or the receiver) is a tracked **user Proxy**
(`_userProxies.has(obj)` — already used by #2180), re-throw `e` instead of
falling through. Keep the existing `_isRevokedProxyError(e)` re-throw for the
non-user-Proxy path (revoked proxies obtained from elsewhere).

```ts
} catch (e) {
  if (_isRevokedProxyError(e) || _userProxies.has(obj)) throw e;
  /* fall through only for genuine WasmGC struct reads */
}
```

Apply to every helper that performs a host MOP read on a value that may be a
user Proxy: `__extern_get`, `__extern_set` (+ `__extern_set_strict`),
`__extern_has`, `__delete_property`, `__getPrototypeOf`,
`__object_setPrototypeOf`, `__getOwnPropertyDescriptor`, `__object_isExtensible`,
`__object_preventExtensions`, `__object_defineProperty`, `__extern_method_call`
(the apply/ownKeys read paths), and the `ownKeys`/key-enumeration helper used by
`Object.keys`/`for-in`/spread. Add a single shared predicate
`_isUserProxy(obj)` and a `_rethrowIfProxyOrRevoked(e, obj)` helper to keep the
13 sites consistent (single source of truth, matching the architect's "shared
predicate module" note in #1355).

### §10.5 invariant surfacing
For the helpers that today *coerce* a bad trap result to a safe default instead
of letting the host engine throw (the getPrototypeOf `→ null` repro), make the
host MOP operation the **last** thing in the `try` so the host engine's own
invariant check runs and throws, and let the broadened catch re-throw it. Do
**not** re-implement §10.5 invariants in the runtime for host mode — the host
engine already enforces them; the bug is purely that we were intercepting before
the engine could throw. (Standalone invariant enforcement is a *separate*,
deferred concern under #1355 — see parent.)

### Edge cases
- A genuine WasmGC-struct read that legitimately throws (e.g. a getter that
  throws) on a **non-proxy** struct must still fall through to the struct path
  only when appropriate — gate the broadened re-throw strictly on
  `_isUserProxy(obj)`, so non-proxy behavior is unchanged.
- `__extern_set_strict` (ESM strict writes): a Proxy `set` trap returning falsy
  must throw TypeError in strict context — ensure the broadened re-throw covers
  the strict helper too.
- The thrown value must reach the compiled `try/catch` via the existing
  `lastCaughtException` exception bridge (same path revoked-proxy errors take) so
  `e instanceof TypeError`/`RangeError` holds in the user program.

### Test-gate (test262, gc mode)
- All `built-ins/Proxy/*/return-is-abrupt*.js`
- `getPrototypeOf/trap-result-neither-object-nor-null-throws-boolean.js`,
  `getPrototypeOf/not-extensible-not-same-proto-throws.js`,
  `getPrototypeOf/instanceof-target-not-extensible-not-same-proto-throws.js`
- `getOwnPropertyDescriptor/resultdesc-is-not-configurable-not-writable-targetdesc-is-writable.js`
- a representative `setPrototypeOf/*` and `defineProperty/*-throws.js`
- `tests/issue-2617.test.ts` — trap-throws-propagates + getProto-non-object-throws.

### Sequencing
Best landed **after #2615** (the get-read fix), because several abrupt/invariant
tests first read through the proxy (which #2615 unblocks) before reaching the
throw. Not a hard dependency, but the gate set overlaps; coordinate so the two
PRs don't fight over the same Proxy test files.

### Risk
Medium — the boundary `catch` is a hot path; the `_isUserProxy` gate keeps the
non-proxy fast path identical. Validate full gc equivalence (broad-impact:
boundary helpers).
