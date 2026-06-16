---
id: 1100
title: "Wasm-native Proxy: meta-object protocol without JS host"
status: in-progress
assignee: ttraenkler/se1
created: 2026-04-12
updated: 2026-06-16
priority: top
feasibility: hard
reasoning_effort: max
task_type: feature
language_feature: proxy
goal: spec-completeness
sprint: 62
es_edition: ES2015
note: "2026-06-15: elevated to TOP priority by stakeholder (Proxy/Promise/async-to-100% epic). Standalone Proxy Phase 1 (get/set/has/apply + revocable). Needs architect spec before dev dispatch; precedes #1355 (remaining traps to 100%)."
---
# #1100 — Wasm-native Proxy: meta-object protocol without JS host

## Problem

Proxy is currently skipped entirely in test262 and has no compilation strategy. In JS-host mode, Proxy objects could theoretically be delegated to the host's `Proxy` constructor, but this doesn't work for standalone mode and doesn't address the 1,087 opaque-object failures (#983) that stem from WasmGC structs being non-introspectable by JS-side Proxy traps.

For a standalone Wasm target, Proxy requires a compile-time meta-object protocol: intercepting property access, assignment, `in`, `delete`, function call, and `construct` at the call site, not at the object.

## Approach (compile-away strategy)

Proxy traps can be compiled as a **vtable dispatch on property operations**:

1. Every object that *might* be a Proxy gets its property operations routed through a trap table (a WasmGC struct of function references)
2. Non-Proxy objects use a direct-dispatch trap table (identity functions)
3. Proxy objects use a user-provided trap table
4. `Proxy.revocable` sets the trap table to a throwing stub

This is similar to how V8 handles Proxy internally — the meta-object protocol is a dispatch table, not runtime magic.

## Key challenges

- **Performance**: every property access on a potentially-Proxy value goes through an indirect call
- **Scope**: 14 trap types (get, set, has, deleteProperty, ownKeys, getOwnPropertyDescriptor, defineProperty, preventExtensions, isExtensible, getPrototypeOf, setPrototypeOf, apply, construct, enumerate)
- **Invariant checking**: Proxy traps have spec-mandated invariants that must be enforced

## Acceptance criteria

- [ ] `new Proxy(target, handler)` compiles in standalone mode
- [ ] At least `get`, `set`, `has`, `apply` traps work correctly
- [ ] Proxy.revocable works
- [ ] test262 Proxy tests begin passing (target: ≥50% of non-skipped Proxy tests)

## Related

- #983 WasmGC opaque object leak (symptom of missing Proxy support)
- #797 Property descriptor subsystem (Proxy traps interact with descriptors)

## Implementation Plan

(Author: architect, 2026-05-21. Large multi-phase feature; the plan
below scopes a minimum-viable Proxy that lands the four core traps,
defers the other ten as follow-ups.)

### Entry point

- `src/codegen/builtins/proxy.ts` (new) — handles `new Proxy(t, h)`
  lowering.
- `src/codegen/property-access.ts` — branch on receiver "may be
  Proxy" before emitting struct.get/set.

### Data structure

```wat
(type $ProxyTraps (struct
  (field $get        (ref null funcref))
  (field $set        (ref null funcref))
  (field $has        (ref null funcref))
  (field $apply      (ref null funcref))
  ;; Phase 2: 10 more traps
))
(type $Proxy (sub (struct
  (field $tag i32)               ;; PROXY_TAG (#1325 registry)
  (field $target (ref null any))
  (field $handler (ref null any))
  (field $traps (ref $ProxyTraps))
  (field $revoked (mut i32))
)))
```

### Numbered algorithm

1. **Construction** — `new Proxy(t, h)`:
   1. Allocate `$Proxy` struct with tag = PROXY_TAG.
   2. Read each trap by name from `h` (get/set/has/apply for Phase 1),
      store as funcref in `$traps`.
   3. Return the proxy struct.

2. **Property read** — `p.x` where `p` may be Proxy:
   1. `ref.test $Proxy` on receiver.
   2. If true and `$traps.get` not null: build `[target, "x", p]`
      argument vector, `call_ref` the trap, return its value.
   3. Otherwise: existing externref/struct.get path.

3. **Property write** — `p.x = v`: symmetric to read with `$set`.

4. **`'x' in p`** — `$has` trap.

5. **`p()` / `p.call(...)`** — `$apply` trap if `p` is a function-like
   proxy.

6. **`Proxy.revocable`** — return `{proxy, revoke}` where `revoke`
   sets `$revoked = 1`; every trap dispatch checks the bit first.

### Edge cases

- **Symbol-keyed access** — trap receives the symbol via the key arg.
- **Invariant violation** — e.g. `getOwnPropertyDescriptor` reports
  a non-existent property on a non-extensible target. Phase 2 work.
- **Reflect.* operations** — defer; Reflect can be implemented in
  Phase 2 as wasm functions that invoke the same trap dispatch.
- **Proxy target is itself a Proxy** — recursive dispatch; must
  unwrap once per level. The trap funcref returns the raw target on
  identity-equality probes (e.g. `proxy === proxy`).
- **Revoked proxy** — every trap throws TypeError. Check `$revoked`
  bit at trap dispatch entry.
- **Receiver-vs-target binding for `get`** — spec passes
  `(target, property, receiver)`; ensure trampoline pushes `receiver`
  not `target` when called via `obj.method()`.
- **null / undefined target** — spec rejects at construction; throw
  TypeError before allocation.

### Test262 paths

- `test/built-ins/Proxy/*/get/*` — Phase 1
- `test/built-ins/Proxy/*/set/*` — Phase 1
- `test/built-ins/Proxy/*/has/*` — Phase 1
- `test/built-ins/Proxy/apply/*` — Phase 1
- All others — Phase 2.

Phase 1 acceptance: ≥30% of non-skipped Proxy tests pass.

### Dependencies

- **#1325** — instanceof tag registry; PROXY_TAG must be registered.
- **#983** — `_wrapForHost` must NOT wrap proxies (already correct);
  document the contract.
- **#1101** WeakRef — independent.

### Risks

- **Hot-path slowdown**: every property access now needs `ref.test
  $Proxy`. Mitigate by static analysis — only emit the test when the
  receiver's type may include Proxy. For untyped externref receivers
  we already pay a host call, so no net regression.
- **Spec invariant enforcement** is fiddly; Phase 1 explicitly does
  NOT enforce invariants (spec says traps "should" return consistent
  values; non-compliant trap behaviour is technically allowed to
  throw, which Phase 2 will do).

## Implementation Plan (revised — architect, 2026-06-16)

(Supersedes the earlier draft above. Standalone/pure-Wasm only. Phase 1 =
get/set/has/apply + revocable. Remaining traps + full invariants are #1355.
Host-mode companion is #2180.)

### Root cause / gap

In standalone mode there is no host `Proxy`. Today the compiler hard-errors:
`new Proxy` → `new-super.ts:2074-2078`; `Proxy.revocable` → `calls.ts:5247-5256`.
So every `built-ins/Proxy` test fails to compile standalone. Phase 1 lands a
Wasm-native meta-object protocol for the 4 highest-impact traps. The object
model to extend is `$Object` in `src/codegen/object-runtime.ts:210-226`,
created by `ensureObjectRuntime(ctx)`. Standalone reads/writes flow through
`__extern_get`/`__extern_set`/`__extern_has`/`__delete_property`.

### WasmGC representation

Add `$ProxyTraps` (struct of 4 funcref fields: get/set/has/apply) and `$Proxy`
as a **subtype of `$Object`** (so existing `ref.test $Object` guards still match)
with extra fields: `$ptag` (PROXY_TAG), `$ptarget` (ref null any), `$phandler`
(ref null any), `$ptraps` (ref $ProxyTraps), `$revoked` (mut i32). Subtyping is
the lowest-churn discriminator — add one extra `ref.test $Proxy` at dispatch
sites. Register PROXY_TAG in the instanceof tag registry (#1325) or use a bare
`ref.test $Proxy` if #1325 is unlanded.

### Trap-dispatch architecture

`p.x` → `ref.test $Proxy(p) ? __proxy_get_dispatch(p,"x",p) : existing __extern_get`.
`__proxy_get_dispatch(proxy,key,receiver)` (new runtime helper from a
`ensureProxyRuntime(ctx)` slice): (1) if `$revoked` → throw TypeError;
(2) `trap = $ptraps.$get`; if null → forward `__extern_get($ptarget,key)`;
(3) else `call_ref trap ($ptarget,key,receiver)`. set/has symmetric; apply only
when `$ptarget` is callable and call site is a CallExpression on the proxy.
Phase 1 does NO §10.5.8 result-invariant check (that is #1355).

### Construction

`new Proxy(t,h)` (new-super.ts): §28.2.1.1 — if t or h not object → throw;
allocate `$ProxyTraps` reading get/set/has/apply off h via `__extern_get`
(callable→funcref via the existing closure-call bridge, else null);
`struct.new $Proxy`; return as externref via `extern.convert_any`.
`Proxy.revocable(t,h)` (calls.ts): build the `$Proxy`, build a `revoke` closure
capturing it (sets `$revoked=1`, nulls target/handler/traps per §28.2.2.1.1),
return a 2-field `{proxy,revoke}` object.

### Property read/write/has integration

`src/codegen/property-access.ts`: at each standalone Get/Set/HasProperty site,
branch on `ref.test $Proxy(receiver)` ONLY when inference can't prove a
non-proxy receiver (typed concrete struct/class locals skip the test → hot path
unaffected); externref/unknown/object receivers get the proxy branch.

### Invariant enforcement (Phase 1 scope)

Only the revoked-proxy invariant. §10.5.7/8/9 result-consistency invariants are
deferred to #1355. Phase 1 must not trap the module on them — just return the
trap result.

### Edge cases
non-object target/handler → TypeError; `proxy[sym]` → symbol externref to trap;
`proxy.m()` passes receiver=proxy; proxy-of-proxy recurses to a non-proxy target;
`proxy === proxy` ref identity; missing trap forwards to ordinary [[Get]].

### Test-gate plan (test262)
Phase 1 target ≥30% non-skipped `built-ins/Proxy` standalone. Gate
`built-ins/Proxy/{get,set,has,apply}/**`, `revocable/**`,
`create-{target,handler}-is-not-object-throws.js`; `tests/issue-1100.test.ts`.
Regression: the `$Proxy <: $Object` subtype change touches every `ref.test
$Object` — full standalone equivalence suite must stay green.

### Dependencies / risks
#1325 tag registry (or bare `ref.test $Proxy`); #1355 depends on this; audit
every `struct.get $Object` site to `ref.test $Proxy` first; reuse the
closure→funcref bridge, do not invent a calling convention.

## Implementation Progress (se1, 2026-06-16, sprint 62) — WIP, foundation landed

### Done (validated, on branch `issue-1100-standalone-proxy-phase1`)

The **highest-risk piece is resolved**: the WasmGC `$Proxy <: $Object` subtype
question. In `src/codegen/object-runtime.ts` (`ensureObjectRuntime`):

- `$Object` is now declared as a **non-final `sub` type** (`{ kind: "sub",
  superType: null, final: false, type: <struct> }`) with its field list
  factored into a reusable `objectFields` const — **layout/field-indices
  unchanged**.
- Added `$ProxyTraps` (struct of 4 `funcref` fields: get/set/has/apply) and
  `$Proxy` as `{ kind: "sub", superType: objectTypeIdx, final: false }` whose
  struct repeats `objectFields` then appends `ptag` (i32), `ptarget`
  (ref null $Object), `phandler` (ref null $Object), `ptraps` (ref null
  $ProxyTraps), `revoked` (mut i32).
- `ObjectRuntimeTypes` extended with `proxyTrapsTypeIdx` + `proxyTypeIdx`.

**Verified:** `tsc` clean; a standalone object program (`{}` + `o.x=7`)
compiles AND `WebAssembly.validate` returns true (so the subtype declaration
is accepted by the engine — the `$Object`-non-final change is regression-safe);
`tests/issue-2084`/`issue-2086` object-runtime suites pass.

### Remaining (resume here)

1. ~~**`ensureProxyRuntime(ctx)`**~~ **DONE** (se1, 2026-06-16) — added to
   object-runtime.ts, called at the end of `ensureObjectRuntime` (after
   `__extern_get/set/has` are registered). Registers the uniform trap func type
   `(externref,externref,externref)->externref` and `__proxy_get_dispatch` /
   `__proxy_set_dispatch` / `__proxy_has_dispatch`: each casts to `$Proxy`,
   throws TypeError on `revoked` (via `__new_TypeError` + exn tag), reads the
   trap funcref from `$ptraps` (null when `$ptraps` itself is null), forwards to
   `__extern_get/set/has(ptarget,…)` when the trap is absent, else `ref.cast` to
   the trap type + `call_ref (target,key,receiver)`. tsc clean; module still
   `WebAssembly.validate`s true; object suites (issue-2084) pass. NOTE: helpers
   are currently unreferenced so DCE drops them from the WAT until step 2 wires
   the guard — expected. STILL TODO in this bucket: the `apply` trap (only at a
   CallExpression on a proxy whose `ptarget` is callable — needs the
   closure-call site, deferred to step 5).
2. **Dispatch injection** — at the TOP of `__extern_get` / `__extern_set` /
   `__extern_has` bodies (object-runtime.ts ~702/1141/1659), prepend
   `local.get $objParam; ref.test $Proxy; if → return __proxy_*_dispatch(...)`.
   This is the architect's "branch at the helper" approach (minimal churn vs.
   editing every property-access.ts call site). NOTE the helpers take the obj
   as externref param 0 — test the **raw externref** via `any.convert_extern;
   ref.test $Proxy` before the existing `ref.cast $Object`.
3. **Construction** — `new Proxy(t,h)` in `new-super.ts` (replace the
   hard-error at the `expr.expression.text === "Proxy"` block, ~2114, gated on
   `ctx.standalone`): §28.2.1.1 non-object t/h → TypeError; build `$ProxyTraps`
   reading get/set/has/apply off `h` via `__extern_get` (callable→funcref via
   the existing closure-call bridge — find it in calls.ts, reuse; null
   otherwise); `struct.new $Proxy` (pass dummy $Object base fields: an empty
   PropMap like `__new_plain_object` does, proto null, counts 0); return via
   `extern.convert_any`.
4. **`Proxy.revocable(t,h)`** in `calls.ts` (replace hard-error ~5339, gated on
   standalone): build the `$Proxy`, build a `revoke` closure capturing it that
   sets `revoked=1` + nulls target/handler/traps, return `{proxy,revoke}` 2-field
   object.
5. **apply trap** — at the CallExpression dispatch in calls.ts, when the callee
   is a proxy (`ref.test $Proxy`) and `ptraps.apply` non-null, route through it.
6. **Tests** — `tests/issue-1100.test.ts`: WASI-mode get/set/has/apply +
   revocable (revoked → TypeError), missing-trap forwarding, non-object target
   → TypeError.

### Resume steps
Worktree: `/workspace/.claude/worktrees/issue-1100-standalone-proxy-phase1`
(branch `issue-1100-standalone-proxy-phase1`). `git merge upstream/main` first
(may have drifted), then continue at step 1 above. Reuse the closure→funcref
bridge and the exn-throw helpers already in object-runtime.ts; do NOT invent a
calling convention (architect risk note). Validate each step with
`WebAssembly.validate` on a scoped repro before moving on. Full standalone
equivalence suite must stay green (the `$Object` non-final change is the
regression-surface — already smoke-clean here).
