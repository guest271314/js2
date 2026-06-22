---
id: 2615
title: "Proxy (host): a `new Proxy` result typed as its target's struct causes every read through the proxy to trap (~32+ fails)"
status: done
sprint: 65
created: 2026-06-22
updated: 2026-06-22
completed: 2026-06-22
assignee: ttraenkler/agent-acc861f0e7aea64c8
priority: top
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: proxy
goal: spec-completeness
parent: 1355
related: [2180]
test262_bucket: proxy-get-read-through-host-proxy
---
# #2615 — Proxy (host): `new Proxy` result must be storage-typed `externref`, not the target's struct type

Slice of #1355. The single highest-leverage host-mode Proxy bug: it made
*every* property READ through a Proxy trap at runtime, which is why the
`built-ins/Proxy/get/**` directory and many read-through tests failed. Fixing it
unblocks acceptance criterion #1 of #1355 (`built-ins/Proxy/get/return-trap-result.js`).

## Root cause

`new Proxy(target, handler)` codegen (`src/codegen/expressions/new-super.ts`)
correctly returns `{ kind: "externref" }` (host) / the native `$Proxy` externref
(standalone). **But a Proxy carries no TypeScript-type brand** — `ProxyConstructor`
is typed to return its TARGET type `T`, so the checker types
`const p = new Proxy(t, h)` as `T` (the object-literal struct of `t`). The
receiving local was therefore slotted as the target's WasmGC struct `(ref null N)`.
The Proxy externref is coerced into that struct slot with `any.convert_extern`
+ `ref.test (ref N)`, which **fails** for a host/native Proxy (it is not that
struct) → the value becomes `ref.null N`, and the subsequent `p.attr` lowers to a
direct `struct.get N 0` on the null/struct local → an empty-message Wasm trap.
(`"k" in p` worked only because it routes via `__extern_has`, never `struct.get`.)

This is the `project_proxy_no_ts_type_brand` memory in concrete form.

## Fix

`src/codegen/statements/variables.ts` — mirror the existing `isBindHostCall` /
`isPromiseHostCall` slot-type overrides. Added `isProxyConstruction(expr)` and
forced the variable's storage ValType to `externref` whenever the initializer is
a `new Proxy(...)`, so member reads/writes/has/delete lower through the dynamic
boundary helpers (`__extern_get` / `__extern_set` / `__extern_has`) — the only
paths that run the Proxy MOP / trap. Two sites:
1. The `wasmType` computation (the override chain) — fresh slots.
2. The pre-hoisted-slot retype guard (`let`/`const` are pre-allocated by
   `hoistLetConstWithTdz` as the struct ref) — narrowing ref → externref is
   safe here (the hoist pass emits no init for ref locals), same rationale as
   the accessor-literal branch.

Mode-agnostic: both host and standalone emit a Proxy externref, so both get the
override. (Reflect directory unchanged — verified 82/19/52 identical.)

## Test Results (local harness, gc mode, via `wrapTest` + `compileAndInstantiate`)

`built-ins/Proxy/get` directory: baseline **2 pass / 3 fail / 14 err** →
**7 pass / 7 fail / 5 err** (+5 pass, −9 err).

Whole `built-ins/Proxy` directory: baseline **78 pass / 52 fail / 181 err** →
**82 pass / 63 fail / 166 err** (net **+4 pass**, −15 err). (Local harness lacks
some host shims so the absolute pass count is below CI's 115; the *delta* is what
matters.) `built-ins/Reflect`: identical 82/19/52 (no regression).

Acceptance: `built-ins/Proxy/get/return-trap-result.js` now PASSES (was an
empty-message trap).

Dedicated equivalence test: `tests/issue-2615.test.ts` (6 cases — get-trap read,
read-through-no-trap-no-longer-traps, `in`, set, delete, set-trap) all pass.

The closed-struct read-through value (`trap-is-undefined.js` returning the
target's actual field for a non-`any` target) and the
`return-trap-result-accessor-property.js` `Object.defineProperty(target,…)`
interaction remain deferred — they need host introspection of a closed WasmGC
struct target and are out of scope for this slice (folded into the broader #1355
read-through-to-struct-target work). Both were already non-pass on `main`.

## Scoped checks

`tsc --noEmit` clean · `prettier --check src/**/*.ts` clean ·
`tests/issue-2615.test.ts` 6/6 pass · existing `proxy-passthrough` /
`struct-proxy-wrappers` / `anon-struct` failures are pre-existing on `main`
(identical sets), not regressions.
