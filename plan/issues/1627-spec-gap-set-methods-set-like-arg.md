---
id: 1627
title: "spec gap: Set methods (union/intersection/etc.) accept any set-like argument (101 test262 fails)"
status: done
created: 2026-05-08
updated: 2026-07-03
completed: 2026-06-28
assignee: ttraenkler/agent-a20aa13da21b8d592
priority: medium
feasibility: easy
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: set
goal: spec-completeness
sprint: 69
renumbered_from: 1352
parent: 1328
---

# #1352 — Set new methods: accept any set-like (size + has + keys)

## Problem

`built-ins/Set`: **282 / 383 pass (73.6%) — 101 fails (46 assertion_fail, 39 other, 7 wasm_compile,
7 runtime_error)**.

Spec §24.2.2.x (ES2025 stage 4): the new Set methods must accept any "set-like" object as their
argument — defined as an object with:

- `size` property (number)
- `has(key)` method (returns boolean)
- `keys()` method (returns iterator)

The new methods (union, intersection, difference, symmetricDifference, isSubsetOf, isSupersetOf,
isDisjointFrom) call `GetSetRecord(other)` which does a structural-typing check on the argument.

The 39 'other' errors suggest the methods throw when passed a non-Set with the right shape — e.g.,
a Map (which has `size` and `has` but `keys()` returns key iterator). Spec accepts Maps.

## Acceptance criteria

1. `built-ins/Set/prototype/union/set-like-arg.js` passes.
2. `built-ins/Set/prototype/intersection/setlike-with-non-callable-keys.js` passes.
3. `built-ins/Set/prototype/difference/setlike-with-throwing-has.js` passes.
4. Pass-rate for `built-ins/Set` rises from 74% to ≥90%.

## Files to modify

- `src/runtime.ts` — `__set_union`, `__set_intersection`, etc.
- `src/codegen/registry/set.ts`

## Implementation Plan

### Root cause

Each new Set method currently does an `instanceof Set` check on its argument; spec actually requires
a structural-typing check via `GetSetRecord`:

```javascript
function GetSetRecord(obj) {
  if (typeof obj !== "object" || obj === null) throw TypeError;
  const rawSize = obj.size;
  const numSize = ToNumber(rawSize);
  if (Number.isNaN(numSize)) throw TypeError;
  const intSize = Math.max(0, Math.trunc(numSize));
  const has = obj.has;
  if (typeof has !== "function") throw TypeError;
  const keys = obj.keys;
  if (typeof keys !== "function") throw TypeError;
  return { Set: obj, Size: intSize, Has: has, Keys: keys };
}
```

### Approach

Replace the `instanceof Set` guard with `GetSetRecord` per spec. When the argument size is smaller
than `this.size`, iterate the argument; otherwise iterate `this`. This is also a perf optimization.

### Edge cases

- Argument with `size` returning NaN → TypeError.
- Argument with size = Infinity → use Infinity but iterate `this` (smaller).
- has/keys throw → propagate.

### Test262 sample

- `test262/test/built-ins/Set/prototype/union/set-like-arg.js`
- `test262/test/built-ins/Set/prototype/intersection/setlike-with-non-callable-keys.js`
- `test262/test/built-ins/Set/prototype/difference/setlike-with-throwing-has.js`

## Frontmatter reconcile (2026-06-12)

Was `in-progress` with no open PR, no active agent, and no Suspended Work section (session died sprints 42-52). Reset to `ready` during the sprint-62 issue review; re-validate against current main before claiming (#2148).

## Resolution (2026-06-28) — GetSetRecord host-bridge adapter

### Verify-first magnitude recheck

The "101 fails" in the title was a 2026-06-19 baseline. On current `main`
(post-#1352/#2607 `_wrapForHost` bridge), `built-ins/Set` is **328/383 pass, 55
non-pass** (52 fail + 3 compile_error). ~45 of the 55 are the set-like-arg
cluster across the 7 set-algebra methods. Still the single biggest `built-ins`
lever, so the scope was confirmed and taken.

### Root cause (host / JS-host gc lane — the lane test262 conformance runs)

The receiver crosses to the host as a **real JS `Set`**, so native V8's
`Set.prototype[m]` runs the spec `GetSetRecord(other)` on the WasmGC-struct
argument. The bridge (`resolveImport`, `runtime.ts`) wrapped that arg with the
`_wrapForHost` proxy, whose **generic `__call_fn_N` fallback masks EVERY struct
field as a callable `closureBridge`**. So native GetSetRecord:

- saw a non-callable `has = {}` / `keys = {}` as _callable_ → no §24.2.1.2
  `IsCallable` `TypeError` (`has-is-callable` / `keys-is-callable`);
- saw a `size = {valueOf(){…}}` as a _function_, never `ToNumber`-coerced it →
  the coercion side-effect never fired (`size-is-a-number`).

### Fix (scoped, no global `_wrapForHost` change)

`src/runtime.ts`:

1. Extracted the proxy's field-resolution precedence into a module-level
   `_resolveHostField(obj, key, exports)` (accessor getter → sidecar →
   `__sget_` field getter → well-known-symbol sidecar → vivified prototype),
   **behaviour-preserving** — `_wrapForHost` now calls it and applies its bridge
   on top exactly as before.
2. Added `_setLikeRecordForHost(arg, exports, state)`, used **only** by the 7
   set-algebra methods, which reads each GetSetRecord field RAW and presents it
   faithfully: a genuine closure (`__is_closure`) stays a callable bridge; a
   non-closure struct (`{}`, `{valueOf}`) becomes a plain (non-callable)
   `_wrapForHost` object; primitives/undefined pass through. Native
   GetSetRecord's spec validation + coercion then fire correctly.

### Result

`built-ins/Set/prototype` set-algebra dirs: **141 → 159 pass (+18), 0
regressions** (verified via `runTest262File` across all 186 files in the 7 method
dirs). Overall `built-ins/Set` → **346/383 ≈ 90.3 %**, meeting acceptance
criterion #4 (≥ 90 %). Acceptance #2 (`intersection/setlike-with-non-callable-keys`)
and #3 (`difference/setlike-with-throwing-has`) are in the flipped set; #1
(`union/set-like-arg.js`) does not exist in the vendored test262 (the modern
suite splits it into the per-method files now covered). Guard:
`tests/issue-1627.test.ts` (27 tests — 6 happy-path behavioural + 21
GetSetRecord-validation flips). No regression in host-heavy suites
(set-algebra / set-foreach / map-foreach / regexp lastIndex+proto-readers /
loose-eq / spread / dynamic-new-spread).

### Remaining tail (NOT this slice — separate root cause, follow-up)

27 set-like fails remain, all needing host resolution the adapter cannot supply:

- **class-instance set-likes** (`allows-set-like-class`, `set-like-class-order`,
  `set-like-class-mutation` — 18): the host cannot resolve an anonymous
  `new class { get size(){…} has(){…} *keys(){…} }` instance's **prototype**
  getter/methods — `_resolveHostField` returns `undefined` for all three, so
  GetSetRecord sees `size = undefined` → `NaN` → throws. Needs host
  prototype-member resolution for anonymous class instances.
- **`set-like-array`** (7): an array with dynamically-added `size`/`has`/`keys`
  props — the props don't resolve through the struct/sidecar path used here.
- **`set-like-iter-return`** (2): the iterator `return()` close protocol on the
  `keys()` iterator ("`next` is not a function").
  These should be carved as a follow-up issue; this slice meets the issue's
  acceptance criteria and is closed `done`.
