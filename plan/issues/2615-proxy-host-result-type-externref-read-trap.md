---
id: 2615
title: "Proxy (host): a `new Proxy` result typed as its target's struct causes every read through the proxy to trap (~32+ fails)"
status: ready
sprint: 65
created: 2026-06-22
updated: 2026-06-22
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
# #2615 — Proxy (host): `new Proxy` result must be storage-typed `externref`/`any`, not the target's struct type

Slice of #1355. **Host (gc) mode only.** This is the single highest-leverage
host-mode Proxy bug: it makes *every* property READ through a host Proxy trap at
runtime, which is why the `built-ins/Proxy/get/**` directory and many
`*-target-is-proxy` / read-through tests fail. Fixing it unblocks acceptance
criterion #1 of #1355 (`built-ins/Proxy/get/return-trap-result.js`).

## Re-measured evidence (arch, 2026-06-22, against main d970e19a)

Authoritative gc baseline: `built-ins/Proxy` = **115/311 (37.0 %)**. Isolated
repro — *all three throw with an empty (`undefined`) message, i.e. a Wasm trap,
even with NO trap defined*:

```ts
function test() { const t = { attr: 1 }; const p = new Proxy(t, {}); return p.attr; } // THROWS
function test() { const t = { attr: 1 }; const p = new Proxy(t, { get: () => 2 }); return p.attr; } // THROWS
function test() { const t = { attr: 1 }; const p = new Proxy(t, {}); return ("attr" in p); } // OK (returns 1)
```

`has` works; `get` is fundamentally broken for host proxies.

## Root cause

`new Proxy(target, handler)` codegen (`src/codegen/expressions/new-super.ts`
~line 2834, host arm) correctly returns `{ kind: "externref" }` and emits
`call __proxy_create -> externref`. **But the local slot for the variable that
receives it is typed from the TypeScript checker**, and TS types
`new Proxy<T>(t, h)` as `T` (the *target's* type) — `ProxyConstructor` returns
its target type. So `const p = new Proxy(t, {})` declares `p` as the
object-literal struct type `(ref null 8)`, and the externref result is coerced
into that struct slot with `any.convert_extern` + `ref.test (ref 8)`. The host
Proxy externref is **not** a `$Object` struct, so `ref.test` fails → the value
becomes `ref.null 8` → the subsequent `p.attr` lowers to a **direct
`struct.get 8 0` on a null/struct local**, which `ref.is_null`-traps.

Observed WAT for `const p = new Proxy(t, {}); return p.attr;`:

```wat
(local $p (ref null 8))        ;; <-- WRONG: struct-typed, should be externref/any
...
call 0                          ;; __proxy_create -> externref
any.convert_extern
ref.test (ref 8)               ;; fails for a host Proxy
(if ... (else ref.null 8))     ;; p := null
local.tee 1
ref.is_null
(if (then global.get 2 throw 0) ;; <-- TypeError trap (empty message)
    (else struct.get 8 0))      ;; direct field read (never routed via __extern_get)
```

This is the `project_proxy_no_ts_type_brand` memory in concrete form: **a Proxy
carries no TS-type brand**, so a local statically classified as the target's
struct type emits direct (`struct.get`) reads that bypass the `__extern_get`
boundary helper — the only path that runs the host-Proxy MOP (and the trap).

## Implementation Plan

### Goal
Any value produced by `new Proxy(...)` must be stored/typed so that reads/writes
route through the dynamic boundary helpers (`__extern_get` / `__extern_set` /
`__extern_has` / `__extern_method_call`), NOT through a static `struct.get` /
`struct.set` on the target's WasmGC struct type. The boundary helpers already
handle a host Proxy correctly (verified: `has` works because `"k" in p` lowers
to `__extern_has`).

### Approach — type the receiving slot as `externref`/`any`
Do **not** trust the TS type for a `new Proxy` initializer. The compiler already
has a notion of "dynamic/open" storage (the `externref` / open-`$Object` path
used for `const h: any = {…}`). Route `new Proxy` results into it:

**File: `src/codegen/expressions/new-super.ts`** — the host `new Proxy` arm
already returns `{ kind: "externref" }`; that is correct. The fix is upstream,
at the **binding/assignment** site that picks the local's storage type.

**File(s): the variable-declaration / local-slot type resolver** (the code that
maps a `const`/`let` initializer's declared TS type to a Wasm local ValType —
grep for where `resolveWasmType` / the TS type of a `VariableDeclaration` chooses
the local type; likely `src/codegen/statements.ts` declaration handling and/or
`src/codegen/index.ts` local allocation). Add: **if the initializer expression is
a `new Proxy(...)` call, force the local's storage ValType to `externref`
(host) / open `$Object` so member reads/writes lower through the boundary
helpers.** Mirror the existing `const x: any = …` open-object routing
(`project_2542_index_signature_open_object_routing` describes the open-`$Object`
routing machinery — reuse it; do not invent a new path).

### Member-read lowering must honor it
**File: `src/codegen/property-access.ts`** — confirm that when the receiver's
storage type is `externref`/`any`, `compilePropertyAccess` already emits
`__extern_get` (it does for `any`-typed receivers). The fix above is sufficient
*if* the slot type flips to `externref`; verify no residual static
`ref.test $Object`-then-`struct.get` fast path fires for an externref-typed
receiver that happens to alias a struct.

### Edge cases
- `p` reassigned / passed to a function typed as `T` (the target type): the
  externref must still survive — coercing an externref Proxy *into* a `(ref 8)`
  parameter will re-trigger this trap. Where a Proxy externref is passed to a
  struct-typed param, it must stay externref (the callee should also read via
  boundary helpers). Scope this slice to the **direct `const p = new Proxy` +
  read** case (covers the bulk); note cross-function flow as follow-up if any
  gated test still fails.
- `delete p.x`, `p.x = v`, `"x" in p`, `for (k in p)` — all must route through
  the boundary helpers once the slot is externref. `has` already works; verify
  set/delete now do too.
- Do NOT regress the fast (non-Proxy) path: a `const o = { a: 1 }` literal MUST
  keep its closed struct + `struct.get` fast read. Only the `new Proxy`
  initializer flips the slot type.

### Test-gate (test262, gc mode)
- `built-ins/Proxy/get/return-trap-result.js` (acceptance #1 of #1355)
- `built-ins/Proxy/get/return-trap-result-accessor-property.js`
- `built-ins/Proxy/get/trap-is-undefined.js`,
  `get/trap-is-undefined-no-property.js`, `get/trap-is-undefined-receiver.js`
- `built-ins/Proxy/function-prototype.js`
- the `deleteProperty/trap-is-undefined-*` and `*-target-is-proxy` read-through
  cases that currently throw an empty-message trap
- `tests/issue-2615.test.ts` — add a direct equivalence test (`new Proxy(t,{}).attr`,
  `new Proxy(t,{get}).x`, set/delete through a proxy).

### Risk
Touches local-slot type resolution — a hot path. Validate the full gc
equivalence suite; broad-impact (value-rep / read-path), so prefer merge_group /
local-ci over a scoped sweep (`project_broad_impact_validate_full_ci`).
