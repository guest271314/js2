---
id: 1640
title: "spec gap: Reflect.* invariant checks mirror internal-method bugs (83 test262 fails)"
status: blocked
created: 2026-05-08
updated: 2026-05-27
blocked_on: [1630, 1631]
investigation_done: 2026-05-27
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: reflection
goal: spec-completeness
sprint: 50
renumbered_from: 1346
parent: 1328
related: 1334
---
# #1346 — Reflect: invariant checks mirror internal-method bugs

## Problem

`built-ins/Reflect`: **70 / 153 pass (45.8%) — 83 fails (77 assertion_fail, 2 runtime_error,
2 type_error, 1 null_deref, 1 wasm_compile)**.

Spec §28.1 (Reflect): each Reflect.X is a thin wrapper over the [[InternalMethod]] X. Therefore:
1. Reflect.defineProperty mirrors [[DefineOwnProperty]] → blocked on #1335.
2. Reflect.getOwnPropertyDescriptor mirrors [[GetOwnProperty]] → returns full descriptor including
   attribute flags.
3. Reflect.has mirrors [[HasProperty]] → walks prototype chain.
4. Reflect.ownKeys mirrors [[OwnPropertyKeys]] → returns string + Symbol keys in spec-defined order.
5. Reflect.set / Reflect.get pass receiver explicitly.

The 77 assertion_fail failures are mostly cascade effects of #1335 (descriptor-attribute fidelity).

## Acceptance criteria

1. `built-ins/Reflect/defineProperty/symbol-key.js` passes (after #1335).
2. `built-ins/Reflect/ownKeys/return-on-corresponding-order-large-index.js` passes.
3. `built-ins/Reflect/getOwnPropertyDescriptor/return-undefined-for-non-existent-key.js` passes.
4. Pass-rate for `built-ins/Reflect` rises from 46% to ≥80% (after #1335 lands).

## Files to modify

- `src/runtime.ts` — `__reflect_*` host bridges
- `src/codegen/registry/reflect.ts`

## Implementation Plan

### Root cause

Most failures cascade from #1335 (Object.defineProperty descriptor attributes). Once that issue
lands, Reflect.defineProperty and Reflect.getOwnPropertyDescriptor automatically improve.

The remaining gap is Reflect.ownKeys order: spec requires:
1. Integer-indexed keys in ascending numeric order.
2. Other string keys in property-creation order.
3. Symbol keys in property-creation order.

Our `__reflect_ownkeys` host bridge calls JS `Reflect.ownKeys` directly which is correct, but
typed-struct objects don't expose Symbol keys at all (they have no Symbol-keyed slot).

### Approach

1. Block on #1335.
2. For typed objects: extend the attribute-table from #1335 to include Symbol keys (currently
   the table is keyed by string only).
3. After #1335: re-run test262 and verify Reflect tests improve.

### Edge cases

- Reflect.set with receiver = primitive → must invoke setter with the primitive as `this` (no
  TypeError unlike strict-mode regular set).
- Reflect.defineProperty returns `false` on failure (spec mode); Object.defineProperty would throw.

### Test262 sample

- `test262/test/built-ins/Reflect/defineProperty/symbol-key.js`
- `test262/test/built-ins/Reflect/ownKeys/return-on-corresponding-order-large-index.js`

## Findings (2026-05-27, dev investigation)

Ran the full `built-ins/Reflect` suite through `runTest262File` on current
main: **106/153 pass (69%), 47 fail, 0 skip** — already well above the
issue's stated 46% baseline (the descriptor-attribute work since this issue
was filed lifted it). The named sample files in the issue
(`defineProperty/symbol-key.js`, `getOwnPropertyDescriptor/return-undefined-for-non-existent-key.js`)
no longer exist in the vendored test262 — filenames are stale.

The **Reflect.* host bridges themselves are already spec-correct.** Each
`__reflect_*` in `src/runtime.ts:4847-4953` delegates to the host's
`Reflect.X` (wrapping wasm structs via `_wrapForHost`), so invariant checks,
boolean returns, and prototype-chain walks are inherited from V8. There is
**no missing-invariant bug to patch in the Reflect layer.** A focused
"audit Reflect invariants" PR would change nothing.

The 47 failures decompose into two deeper, already-tracked subsystem gaps:

### Cluster A — accessor-descriptor model on struct objects (~30 fails)

Confirmed by direct probe:
`Object.defineProperty(o, 'p', { get() { return 42 } })` then
`Reflect.get(o, 'p')` returns `undefined`, not `42` — the getter is never
wired into the struct-backed object's slot. This is the SAME root cause as
plain member access over a defineProperty getter. Surfaces as the
`get/return-*`, `has/return-boolean`, `getOwnPropertyDescriptor/return-from-*`,
`defineProperty/define-*` ("Getter must be a function: null"),
`ownKeys/*` and `set/*` buckets. **Tracked by #1630 (descriptor-model
writeback, escalated needs-spec) and #1631 (Object.create descriptor map
drops struct-backed descriptors).** Reflect inherits the fix for free.

### Cluster B — compiled-function as host-callable (~8 fails)

`Reflect.apply(fn, thisArg, args)` / `Reflect.construct(ctor, args)` where
`fn`/`ctor` is a compiled wasm function fails with
`Function.prototype.apply was called on [object Object], which is not a
function` — the function reaches the host as a non-callable `_wrapForHost`
struct wrapper. Surfaces as `apply/call-target.js`, `apply/*-array-like*`,
`construct/return-with-newtarget-argument.js`, `construct/*`. This is the
wasm-function → host-callable bridging gap, not Reflect-specific (any host
MOP that needs to *invoke* a compiled function hits it).

### Recommendation

Close as **wont-fix-standalone / superseded**: there is no Reflect-layer
patch that moves the needle. Re-validate the Reflect suite after #1630 +
#1631 (Cluster A) land — that should recover ~30 of the 47. File a separate
issue for Cluster B (compiled-function host-callable bridging) if one does
not already exist; it is orthogonal to the descriptor model and to Reflect.
