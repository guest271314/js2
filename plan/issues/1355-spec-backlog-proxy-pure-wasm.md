---
id: 1355
title: "spec backlog: Proxy implementation beyond JS-host fallback (235 test262 fails)"
status: in-progress
assignee: ttraenkler/sdev-proxy
created: 2026-05-08
updated: 2026-07-04
priority: top
feasibility: hard
reasoning_effort: high
task_type: feature
area: runtime, codegen
language_feature: proxy
goal: spec-completeness
sprint: 67
parent: 1334
depends_on: [1100]
note: "2026-06-15: elevated to TOP priority by stakeholder (Proxy/Promise/async-to-100% epic). Remaining 10 traps + invariant checks to drive Proxy past host-fallback toward 100% (standalone). Follows #1100 Phase 1. Needs architect spec."
---

# #1355 — Proxy: pure-Wasm implementation

## RE-MEASURE + VERDICT (architect, 2026-06-22, against main d970e19a)

Re-grounded the whole Proxy lane in BOTH modes. The original "235 standalone
fails / 21.5 %" framing is stale. Current authoritative gc baseline + a probed
standalone run:

| Category            | host (gc)            | standalone                                                      |
| ------------------- | -------------------- | --------------------------------------------------------------- |
| `built-ins/Proxy`   | **115/311 = 37.0 %** | ~35/311 ≈ 11 % (revocable + standalone Reflect.\* CEs dominate) |
| `built-ins/Reflect` | **122/153 = 79.7 %** | ~39/153 ≈ 25 %                                                  |

(Proxy/Reflect gc numbers verified against the committed
`loopdive/js2wasm-baselines` JSONL; my in-process harness matched exactly:
115/122.)

**Verdict: the tractable lane this sprint is HOST mode, not standalone.** Host
Proxy sits at 37 % and the failures cluster into a handful of _bounded,
root-caused_ bugs — NOT 235 scattered fails. The biggest is a single codegen
bug (`new Proxy` result statically typed as its target's struct → every READ
through the proxy traps), which is the concrete form of the
`project_proxy_no_ts_type_brand` memory. Standalone pure-Wasm invariant
enforcement remains a genuine multi-slice epic and stays deferred (see below).

### Host-mode failure buckets (after subtracting deferred)

Deferred / not Proxy bugs: **~48** — `*-realm.js` (need `$262.createRealm`,
~38) + `*-using-with.js` / `call-with.js` (`with` is on the skip list, ~10).
Subtracting those, the real, tractable host bugs are:

| Bucket                                                                                                                        | ~count                         | Slice     |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | --------- |
| READ through a host proxy traps (`new Proxy` result typed as target struct → `struct.get` on a failed `ref.test` → null trap) | 32+ (folds in much of "OTHER") | **#2615** |
| Present-but-non-callable trap silently dropped instead of TypeError                                                           | 19                             | **#2616** |
| Trap-thrown exceptions + §10.5 invariant TypeErrors swallowed by the boundary `try/catch`                                     | ~40                            | **#2617** |
| apply/construct call path on a host Proxy (illegal cast; construct result ignored)                                            | ~15                            | **#2618** |

These overlap (a `get/return-is-abrupt` test needs both #2615 and #2617), so the
net pass-rate gain is less than the sum, but #2615 alone should move host Proxy
well off 37 % and unblock acceptance criterion #1
(`get/return-trap-result.js`). Realistic target after #2615–#2618: host
`built-ins/Proxy` ≈ 60–70 % (the ≥75 % criterion is plausibly reachable but the
`-realm` deferrals cap the ceiling at ~85 % until `$262.createRealm` exists).

### Standalone — DEFERRED EPIC (with the staged plan below)

Standalone Proxy at ~11 % is dominated by two infrastructure gaps, NOT trap
logic:

1. **`Proxy.revocable` / revoke synthesis is unimplemented standalone** —
   `Proxy not supported in standalone` / `Proxy.revocable built-in` CEs across
   the entire `revocable/**` directory (~14 CEs). This was explicitly deferred
   in #1100 Phase 1.
2. **Several standalone `Reflect.*` methods aren't wired** — `Reflect.setPrototypeOf`
   (10 CE), `Reflect.defineProperty` (8), `Reflect.construct` (6),
   `Reflect.getPrototypeOf` (6), `Reflect.apply`/`isExtensible`/`preventExtensions`
   each ~5 — these CE before any Proxy trap can run. The standalone `Reflect.*`
   path bypasses the Proxy dispatch (architect note below already flagged this).
3. Pure-Wasm §10.5 invariant enforcement (the "Implementation Plan" sections
   below) needs a standalone descriptor-attribute model (#797/#1460/#1462) and
   touches ~13 internal-method dispatchers — genuinely multi-slice.

**Staged standalone approach (predecessor-ordered):**

- **Stage S0 (predecessor, separate issue when scheduled):** standalone
  `Proxy.revocable` + revoke-closure synthesis (finish #1100's deferred piece).
  Until this lands every `revocable/**` standalone test CEs.
- **Stage S1:** wire the missing standalone `Reflect.*` methods
  (setPrototypeOf/defineProperty/construct/getPrototypeOf/apply/isExtensible/
  preventExtensions) so they route through the existing `$Proxy` dispatch
  front-guards instead of CE-ing. This is the biggest standalone CE bucket and
  is mechanical once the dispatch helpers (already present, Slices A–D) are
  reused.
- **Stage S2:** §10.5 invariant enforcement on the standalone dispatchers
  (needs the descriptor-attribute bits — coordinate #797/#1460/#1462).
- **Stage S3:** standalone `construct`/`apply` trap dispatch (the last two
  traps; needs the standalone dynamic-new path).

No standalone slices are manufactured for this sprint — S0/S1 are the next
worthwhile ones and should be filed once a senior-dev/value-rep slot opens. The
detailed pre-existing "Implementation Plan" + per-slice (A–D) sections below
remain the authoritative standalone design for S1–S3.

### Sub-issues filed (sprint 65, host-mode, parent #1355)

- **#2615** — `new Proxy` result must be storage-typed externref, not the
  target struct (read-through-proxy trap). _Highest value; land first._
- **#2616** — present non-callable trap → TypeError (host bridge).
- **#2617** — propagate trap-thrown exceptions + §10.5 invariant TypeErrors
  through the boundary helpers.
- **#2618** — apply/construct call path on a host Proxy (depends on #2615).

## Problem

`built-ins/Proxy`: **67 / 311 pass (21.5%) — 235 fails (146 assertion_fail, 53 type_error,
22 null_deref, 7 wasm_compile, 4 runtime_error)**.

Currently Proxy is supported **only** in JS-host mode by forwarding to host's `new Proxy(target, handler)`.
This is sufficient for some tests but fails on:

1. Internal-method invariant checks (e.g. `[[GetPrototypeOf]]` trap return must match if target is non-extensible).
2. Tests that pass Wasm-typed objects as the target — host can't reflect into our struct.
3. `Proxy.revocable()` and revocation lifecycle — partial.

Spec §10.5 (Proxy Object Internal Methods) and §28.2 (Proxy constructor) require:

- 13 internal methods, each invoking a corresponding handler trap.
- Per-trap invariant validation (e.g. non-configurable property must remain present after [[GetOwnProperty]] trap).
- Constructor must throw if either target or handler is non-object.

## Acceptance criteria

1. `built-ins/Proxy/get/return-trap-result.js` passes.
2. `built-ins/Proxy/getOwnPropertyDescriptor/non-existent-property-throws.js` passes
   (invariant: trap reporting non-existent property must be discardable, not throw).
3. `built-ins/Proxy/ownKeys/return-not-list-object-throws.js` passes.
4. `built-ins/Proxy/revocable/return-is-object.js` passes.
5. Pass-rate for `built-ins/Proxy` rises from 21.5% to ≥75%.

## Implementation notes

A pure-Wasm Proxy needs a meta-runtime: each [[InternalMethod]] on a Proxy struct dispatches
to the trap if present, otherwise forwards to target's [[InternalMethod]]. This requires:

1. **Indirection on every property access**: every `Get`/`Set`/`HasProperty`/etc. site must
   first check `ref.test $Proxy` and divert to the trap-dispatcher. This has measurable
   perf cost on the fast (non-Proxy) path.
2. **Trap-dispatcher**: a runtime function per trap that calls handler[trapName] if defined,
   validates invariants, and either returns or forwards to target.
3. **Revoke list**: per-Proxy weak link to `revoke()` closure that nulls the target+handler.

This is feasibility:hard because every property-access in the codegen (~50 emitter sites)
needs the indirection. Mitigation: keep the indirection **only** when type inference cannot
prove the target isn't a Proxy; for typed locals where we know the type, skip the check.

## Files (eventual)

- `src/codegen/property-access.ts` — Proxy guard at every Get/Set
- `src/codegen/registry/proxy.ts` — `__proxy_dispatch_*` runtime helpers
- `src/runtime.ts` — Proxy.revocable, Proxy.constructor

## Dependency

Cascade-blocks Reflect.\* invariant tests (#1346). Until landed, Proxy stays at host-mode only.

## Implementation Plan (architect, 2026-06-16; sequencing re-confirmed arch1 2026-06-16)

(Standalone/pure-Wasm. Builds on #1100 Phase 1. Adds the remaining 10 trap
dispatchers + full §10.5 invariant enforcement; drives standalone
`built-ins/Proxy` from ~21% to ≥75%. Host-mode companion is #2180.)

### BLOCKED — hard dependency on #1100 (verified against upstream/main 319d43460)

The standalone substrate this plan extends **does not exist on main yet**:
`grep` for `$Proxy` / `$ProxyTraps` / `registerProxyType` / `__proxy_*_dispatch`
in `src/codegen/object-runtime.ts` and `src/codegen/registry/proxy.ts` returns
nothing — `src/codegen/registry/proxy.ts` is not created, and the only `__proxy`
references are the **host-mode** path in `runtime.ts`/`calls.ts`. #1100
(`status: ready`, senior-dev WIP on a branch per s63 task #21) lands
`$Proxy` + `$ProxyTraps` + get/set/has/apply + revocable. **Do NOT dispatch
#1355 until #1100 has merged to main** — every section below presumes
`$ProxyTraps` (the 4 base trap fields) and the standalone Proxy struct exist.
When #1100 lands, re-grep to confirm the field layout of `$ProxyTraps` and the
`$Proxy` struct before extending — coordinate the 9 added funcref fields with
whatever #1100 shipped (append, do not renumber the base 4).

Also note `$PropEntry` exists (`object-runtime.ts:16`) but the
descriptor-attribute bits (configurable/writable/enumerable) needed for §10.5
invariant enforcement may not be present — verify and extend per the Invariant
section below, coordinating with #797/#1460/#1462.

### Root cause / gap

#1100 lands `$Proxy`/`$ProxyTraps` + get/set/has/apply with only the
revoked-proxy invariant. The 235 standalone fails (146 assertion_fail,
53 type_error, 22 null_deref, 7 wasm_compile, 4 runtime_error) are dominated by
(1) the 10 missing traps and (2) missing §10.5 invariant checks.

### Architecture

Extend `$ProxyTraps` (object-runtime.ts) with 9 more funcref fields
(deleteProperty, ownKeys, getOwnPropertyDescriptor, defineProperty,
getPrototypeOf, setPrototypeOf, isExtensible, preventExtensions, construct).
Add one `__proxy_<trap>_dispatch` runtime helper per trap, each shaped:
(1) revoked→throw; (2) read trap funcref; (3) null→forward OrdinaryX on target;
(4) call_ref trap; (5) coerce result to spec type; (6) ENFORCE the §10.5
invariant(s)→TypeError on violation; (7) return.

### Wire operators / builtins

`property-access.ts` + `calls.ts`: `delete proxy.x`→deleteProperty;
`Object.keys/getOwnPropertyNames/getOwnPropertySymbols`/for-in/spread→ownKeys;
`Object.getOwnPropertyDescriptor`→getOwnPropertyDescriptor;
`Object.defineProperty`→defineProperty; `Object.getPrototypeOf`/`__proto__` read→
getPrototypeOf; `Object.setPrototypeOf`/`__proto__` write→setPrototypeOf;
`Object.isExtensible`→isExtensible; `Object.preventExtensions/seal/freeze`→
preventExtensions; `new proxy(...)`→construct. The standalone `Reflect.*` path
(calls.ts:5411-5540) must also route through these when `ref.test $Proxy`
succeeds (today it bypasses to `__extern_*`/`__object_keys`).

### Invariant enforcement (§10.5 — implement from fetched spec text)

§10.5.5 [[GetOwnProperty]], §10.5.6 [[DefineOwnProperty]], §10.5.7
[[HasProperty]], §10.5.8 [[Get]], §10.5.9 [[Set]], §10.5.10 [[Delete]], §10.5.11
[[OwnPropertyKeys]] (List of String/Symbol, no dups, includes non-configurable
keys; non-extensible→exactly target keys), §10.5.1/2 [[GetPrototypeOf]]/
[[SetPrototypeOf]], §10.5.3/4 [[IsExtensible]]/[[PreventExtensions]], §10.5.13
[[Construct]]. Needs a standalone descriptor model — coordinate with
#797/#1460/#1462; extend `$PropEntry` (object-runtime.ts:202) with
configurable/writable/enumerable attribute bits first if absent.

### Standalone vs host scoping

Standalone only. Host (#2180) gets invariants free from the engine. Keep §10.5
invariant predicates + trap-name list in one shared module
(`src/codegen/registry/proxy.ts`) as single source of truth.

### Edge cases

ownKeys non-array/non-String-or-Symbol/dups→TypeError;
getOwnPropertyDescriptor of non-existent on non-extensible→undefined (not throw);
defineProperty partial-descriptor reconciliation; proxy-of-proxy recursion;
symbol keys through every key-taking trap; construct only when target has
[[Construct]].

### Test-gate plan (test262)

≥75% non-skipped `built-ins/Proxy` standalone. Gate
`built-ins/Proxy/get/return-trap-result.js`,
`getOwnPropertyDescriptor/non-existent-property-throws.js`,
`ownKeys/return-not-list-object-throws.js`, `revocable/return-is-object.js`, and
all `built-ins/Proxy/{deleteProperty,ownKeys,getOwnPropertyDescriptor,defineProperty,getPrototypeOf,setPrototypeOf,isExtensible,preventExtensions,construct}/**`;
`tests/issue-1355.test.ts`. Regression: standalone equivalence green; host #2180
unchanged.

### Dependencies / risks

depends_on #1100 (hard prereq); #797/#1460/#1462 descriptor attributes;
cascade-unblocks standalone `Reflect.*` invariants (#1346). Implement strictly
from fetched §10.5 spec text, cite the section in each helper + commit.

## Implementation — Slice A: deleteProperty (sdev-proxy3, 2026-06-17, sprint 63)

Re-validated vs upstream/main fe0e21ba1 before coding: the #1100 Phase-1
substrate (`$Proxy`/`$ProxyTraps` standalone structs, get/set/has dispatch via
`ref.test $Proxy` front-guards on `__extern_get/set/has`, traps invoked through
the `__apply_closure` bridge with the handler bound as `this`) is present. A
probe of each of the 8 remaining traps confirmed they all COMPILE + RUN cleanly
today but the trap NEVER FIRES — it silently forwards to the target. So #1355 is
pure feature-add on a proven dispatch substrate, not a bug hunt.

Slice A wires the **deleteProperty** trap (§10.5.10 [[Delete]]). All in
`src/codegen/object-runtime.ts`; `tests/issue-1355.test.ts` (7 tests, all green;
tsc clean; every program `WebAssembly.validate`s true). #1100's 9 tests stay
green; ordinary (non-proxy) standalone delete verified unaffected.

### How it slots into #1100's architecture (no new machinery invented)

1. **`$ProxyTraps`** gains a 5th field `deleteProperty` (externref closure),
   APPENDED after the #1100 base four (get/set/has/apply) — never renumber the
   base, per the architect note. `__proxy_create` reads it off the open handler
   via `__extern_get` (undefined → null → forward) and stores it in the struct.
2. **`__proxy_delete_dispatch(proxy, key, _recv)`** is built by the existing
   `buildDispatch` helper, treated like `has`: a 2-arg `(target,key) -> i32`
   forward target (`__delete_property`) whose result is boxed via `__box_boolean`
   to keep the dispatch's uniform externref ABI. Takes 3 params (unused receiver
   placeholder) purely so the local indices line up with `buildDispatch`'s
   hardcoded p=local3/trap=local4 layout — the [[Delete]] trap signature itself
   is `(target, key)`, no receiver.
3. **`__proxy_call_delete`** driver (reserve-then-fill, #1719) routes the trap
   through `__apply_closure(trap, handler, «target,key»)` — same bridge as
   has/get/set; filled at FINALIZE by `fillProxyDispatch` (arity 2).
4. **Front-guard** prepended to the native `__delete_property` helper: a
   `ref.test $Proxy` on param0 diverts a proxy receiver to the dispatch and
   coerces its booleanish result back to the delete operator's i32 via
   `__is_truthy` (identical shape to the `__extern_has` front-guard). Because
   BOTH `delete p.x` and `Reflect.deleteProperty(p,k)` lower to
   `__delete_property`, this single guard covers both call forms; computed-key
   `delete p[k]` too.

### Verified semantics (probe + tests)

- trap return value (`true`/`false`) becomes the `delete` operator result;
- trap receives the correct `(target, key)` and can delete through the target;
- absent trap forwards to the ordinary [[Delete]] on the target;
- the revoked-proxy throw is shared with get/set/has (`throwRevoked()` arm), so
  it is enforced — but cannot be exercised standalone until `Proxy.revocable`
  call-site synthesis lands (deferred in #1100, still standalone-unsupported).

### Out of scope for Slice A (later slices, tracked here)

§10.5.10 result-invariant (trap must not report success for deleting a
non-configurable own property → TypeError) deferred to the invariant slice.
Remaining traps: B=ownKeys+getOwnPropertyDescriptor · C=getPrototypeOf+
setPrototypeOf · D=isExtensible+preventExtensions+defineProperty · E=§10.5
invariants + construct/apply.

## Implementation — Slice B: getOwnPropertyDescriptor (sdev-proxy3, 2026-06-17)

Wires the **getOwnPropertyDescriptor** trap (§10.5.5 [[GetOwnProperty]]) into the
standalone meta-object protocol, stacked on Slice A. `$ProxyTraps` +field
`getOwnPropertyDescriptor` (index 5). `__proxy_gopd_dispatch` built by the
shared `buildDispatch` helper as a 2-arg trap (handler, trap, target, key) like
has/delete, but the trap-absent forward returns the descriptor externref
directly (no boolean boxing), like get. A `ref.test $Proxy` front-guard on the
native `__getOwnPropertyDescriptor` helper covers
`Object.getOwnPropertyDescriptor` and `Reflect.getOwnPropertyDescriptor` on
dynamic receivers. Absent trap forwards to the ordinary [[GetOwnProperty]].
§10.5.5 result-invariants (trap must return Object|undefined; non-configurable /
non-extensible consistency) deferred to the invariant slice.
`tests/issue-1355b.test.ts` (6 tests).

## Implementation — Slice C: getPrototypeOf + setPrototypeOf (sdev-proxy3, 2026-06-17)

Wires the **getPrototypeOf** (§10.5.1) and **setPrototypeOf** (§10.5.2) traps,
stacked on Slice B. `$ProxyTraps` +fields `getPrototypeOf` (6),
`setPrototypeOf` (7). These traps take no property key, so they don't fit the
key-centric `buildDispatch`; a parallel `buildProtoDispatch` builds their bodies
(getPrototypeOf forwards `__getPrototypeOf(target)` / trap`(handler, target)`;
setPrototypeOf forwards `__object_setPrototypeOf(target, proto)` dropping its
result and pushing the proxy as a truthy success token / trap`(handler, target,
proto)`). `ref.test $Proxy` front-guards on `__getPrototypeOf` and
`__object_setPrototypeOf` cover `Object.getPrototypeOf`/`setPrototypeOf` and the
`Reflect.*` equivalents; the dispatch returns the trap result externref directly
(no coercion-vocabulary site added). Absent traps forward to the target's
ordinary internal method (verified value-based: prototype field readable through
the proxy identically to the plain target — note standalone prototype-object
`===` identity is a separate pre-existing limitation, independent of Proxy).
§10.5.1/2 non-extensible-target result-invariants deferred to the invariant
slice. `tests/issue-1355c.test.ts` (9 tests).

### Slice sequencing note (stacked branches)

A→B→C are stacked: each branch bases on the previous so the `$ProxyTraps` field
appends stack textually (get/set/has/apply/deleteProperty/
getOwnPropertyDescriptor/getPrototypeOf/setPrototypeOf) without merge conflicts.
PRs are landed in order; each subsequent PR's diff narrows once its parent
merges. Remaining: D=isExtensible+preventExtensions+defineProperty · E=§10.5
result-invariants + construct/apply.

## Implementation — Slice E: ownKeys (sdev-proxy, 2026-06-25, sprint 66)

Re-grounded the whole Proxy lane against current upstream/main (d28fdb2c5)
before coding. State found: the host slices #2615/#2616/#2617 are **done** and
#2618 (host apply/construct) is **blocked + reserved by another session** — so
the host lane is effectively complete and off-limits. Slices A–D (delete, gopd,
getPrototypeOf, setPrototypeOf, isExtensible, preventExtensions) all landed
standalone. The remaining standalone trap gaps are **ownKeys** (completely
unwired — `Object.keys(proxy)` returned `[]`, the trap never fired),
defineProperty (trap field absent), and construct/apply. Picked **ownKeys** as
the highest-value, fully self-contained, non-overlapping slice (no host, no
apply/construct → no overlap with #2618). Probed on main: `Object.keys(p)` with
an `ownKeys` trap returned `0` (trap dropped) — confirming the gap.

Wires the **ownKeys** trap (§10.5.11 [[OwnPropertyKeys]]) on the proven #1100
dispatch substrate. All in `src/codegen/object-runtime.ts`;
`tests/issue-1355e.test.ts` (9 tests, all green). Slices A–D + #1100 tests stay
green (36 + 9); #2042 object-runtime suite (65 tests over
`Object.keys`/`getOwnPropertyNames`/descriptors) unregressed.

### How it slots in (no new machinery)

1. **`$ProxyTraps`** gains a 11th field `ownKeys` (externref closure), APPENDED
   after the base ten — never renumbered. `__proxy_create` reads it off the open
   handler via `__extern_get` (undefined → null → forward) into local 12.
2. **Two dispatch helpers, one trap field** — ownKeys is unique among the traps
   in that its **trap-absent forward target differs per call site**:
   `Object.keys` forwards to `__object_keys` (own _enumerable_ string keys),
   while `Object.getOwnPropertyNames` / `Reflect.ownKeys` forward to
   `__getOwnPropertyNames` (all own string keys). So `buildOwnKeysDispatch`
   takes the forward name as a parameter and is registered twice:
   `__proxy_ownkeys_keys_dispatch` (forward `__object_keys`) and
   `__proxy_ownkeys_names_dispatch` (forward `__getOwnPropertyNames`). Both read
   the SAME `ownKeys` trap field; they diverge only in the absent-trap arm.
3. **`__proxy_call_ownkeys`** driver (reserve-then-fill, #1719) — 1 trap arg
   `(target)`, routed through `__apply_closure(trap, handler, «target»)`, filled
   at FINALIZE by `fillProxyDispatch` (arity 1), same as getPrototypeOf/isExtensible.
4. **Front-guards** prepended to BOTH `__object_keys` and `__getOwnPropertyNames`
   (a `ref.test $Proxy` on param0 diverts a proxy receiver to the matching
   dispatch). `Object.keys`/`getOwnPropertyNames`/`Reflect.ownKeys` on a dynamic
   receiver all funnel through these two helpers, so the two guards cover every
   call form.

### §10.5.11 invariant scope (this slice)

Implemented the **top-level CreateListFromArrayLike Object-type check** (§10.5.11
step 8 → §7.3.18 step 2): when the trap is present, the result must be an Object
or a TypeError is thrown. "is Object" is computed as the complement of ToObject's
primitive cases: `is_null | __typeof_number | __typeof_boolean | __typeof_string`
→ throw. This satisfies acceptance criterion #3
(`built-ins/Proxy/ownKeys/return-not-list-object-throws.js`, `ownKeys`
returning `undefined`) and also rejects boolean/number/string/null returns.

### Deferred (next invariant slice)

- The PER-ELEMENT String|Symbol type check (CreateListFromArrayLike element-type
  step — `built-ins/Proxy/ownKeys/return-type-throws-*.js`).
- §10.5.11 result-invariants: no duplicate keys; non-extensible target → trap
  result must equal the target's exact own keys; must include all
  non-configurable target keys. These need the standalone descriptor-attribute
  model (#797/#1460/#1462).

### Known pre-existing limitations (NOT introduced here, verified via no-proxy controls)

- Reading individual **string-key elements** of the result via `[i]` returns
  `undefined` — the `$ObjVec` string-element readback gap, reproduced WITHOUT any
  proxy. Tests assert via `.length` / side-effects / the throw path instead.
- A trap whose body **directly tail-returns a call result** (`(t) => Object.keys(t)`)
  throws through the `__apply_closure` bridge, while the assign-then-return form
  (`(t) => { const z = Object.keys(t); return z; }`) works — a pre-existing
  closure-body-shape limitation in the bridge, independent of ownKeys.

### Remaining standalone slices after E

F = defineProperty trap (§10.5.6) · G = §10.5 result-invariants (needs descriptor
attributes) · H = construct/apply trap dispatch (the last two; needs the
standalone dynamic-new path). Plus Stage S0/S1 from the RE-MEASURE section
(standalone `Proxy.revocable` + missing `Reflect.*` wiring).

## Implementation — Slice F: defineProperty (dev-builtin-ctor, 2026-06-25, sprint 66)

Re-grounded against current upstream/main (27ef33522) before coding: probed a
Proxy with a `defineProperty` trap — `Object.defineProperty(p, k, desc)` and
`Reflect.defineProperty(p, k, desc)` BOTH silently forwarded to the target
without firing the trap (returned the no-fire value), confirming the gap.
`$ProxyTraps` had no `defineProperty` field; next free index = 11.

**Bounded-check (the load-bearing gate):** the base trap DISPATCH does NOT need
the #797/#1460/#1462 descriptor-attribute model. The trap is `(target, key,
descriptor) → boolean`: it RECEIVES the descriptor as an opaque externref (the
call site already has it) and RETURNS a boolean; the user trap's own body reads
the descriptor. Only the §10.5.6 result-INVARIANTS (reconciling a returned
definition against the target's existing non-configurable / non-extensible
descriptor) need the descriptor model — DEFERRED to slice G, exactly as slices
A–E deferred theirs.

Wires the **defineProperty** trap (§10.5.6 [[DefineOwnProperty]]) on the proven
#1100 dispatch substrate. `tests/issue-1355f.test.ts` (10 tests, all green).
Slices A–E + #1100 tests stay green; #1460/#1462/#1629/#2042/#2046 descriptor
suites unregressed (146 tests over the full proxy + descriptor regression run).

### How it slots in (template = ownKeys slice E, no new machinery)

1. **`$ProxyTraps`** gains a 12th field `defineProperty` (externref closure),
   APPENDED after the base eleven — never renumbered. `__proxy_create` reads it
   off the open handler via `__extern_get` (undefined → null → forward) into
   local 13; the `struct.new $ProxyTraps` gains the 12th arg.
2. **`buildDefineDispatch`** — a 3-arg trap builder (`defineProperty` is the only
   key+descriptor trap, so it doesn't fit the key-only `buildDispatch`):
   `__proxy_define_dispatch(proxy, key, desc)` reads the trap; null → forward
   `__obj_define_from_desc(target, key, desc)` (the native single-descriptor
   applier — the #2046-reused path); else invoke the trap `(target, key, desc)`
   with the handler bound as `this`, the descriptor passed through UNCHANGED.
3. **`__proxy_call_define`** driver (reserve-then-fill, #1719) — 3 trap args,
   routed through `__apply_closure(trap, handler, «target,key,desc»)`, filled at
   FINALIZE by `fillProxyDispatch` (arity 3), same bridge as get/set.
4. **Front-guard** prepended to `__obj_define_from_desc` (a `ref.test $Proxy` on
   param0 diverts a proxy receiver to the dispatch). The `Reflect.defineProperty`
   call site (calls.ts) now coerces the applier's externref result via
   `__is_truthy` instead of dropping it + returning a hard `true`, so a proxy
   trap's `false`/`true` return is observable (a non-proxy receiver returns the
   always-truthy obj, so the spec `true` is preserved unchanged).
5. **Inline-literal call-site reroute** (object-ops.ts) — `Object.defineProperty`
   with an INLINE `{...}` data descriptor on a _syntactic_ `new Proxy(...)`
   receiver (a direct `new Proxy(...)` arg, or an identifier whose var-decl
   initializer is `new Proxy(...)`) routes through `emitDefinePropertyDescRuntime`
   → `__obj_define_from_desc` (where the front-guard lives), instead of the
   inline `__defineProperty_value` fast path that would store directly on the
   proxy externref. Gated on the SYNTACTIC proxy shape (not a bare `any`
   receiver) to avoid swallowing the §19.1.2.4-step-1 non-object throw for
   `const o: any = null`. Accessor descriptors keep the existing path.

### Verified (per-process test262, NOT the in-process loop)

6 of the 8 non-realm `built-ins/Proxy/defineProperty/*` rows flip to `pass`
standalone: `call-parameters`, `return-boolean-and-define-target`,
`trap-is-null-target-is-proxy`, `trap-is-undefined`, `null-handler`,
`trap-return-is-false`. The 2 still-failing (`trap-is-missing-target-is-proxy`,
`trap-is-undefined-target-is-proxy`) are proxy-OF-proxy + array-exotic `length`
invariant — beyond bounded slice F. Host/gc mode is byte-identical (the dispatch

- front-guard + reroute are all `ctx.standalone`-gated).

### Deferred (next invariant slice G — needs the descriptor-attribute model)

Per the probe, the existing slices (has/get/…) do NOT enforce these either, so
they are consistently deferred: present-but-non-callable trap → TypeError
(§10.5.6 step 5 GetMethod); trap-thrown abrupt-completion propagation (the shared
closure-bridge gap, RE-MEASURE bucket #2617); the §10.5.6 result-invariants
(reject a non-configurable/non-extensible redefine disagreeing with the target's
descriptor — the 6 `targetdesc-*` rows). Proxy-of-proxy recursion through the
define forward is also deferred.

### Remaining standalone slices after F

G = §10.5 result-invariants (needs descriptor attributes #797/#1460/#1462) ·
H = construct/apply trap dispatch (the last two traps; needs the standalone
dynamic-new path). Plus Stage S0/S1 from the RE-MEASURE section (standalone
`Proxy.revocable` + missing `Reflect.*` wiring).

## Residual (as of #2199, PO reconcile 2026-06-28)

NOT done — umbrella. The referencing merged PR landed one slice (defineProperty trap, §10.5.6, standalone). The ~10 remaining Proxy traps + invariant checks toward 100% standalone (past host-fallback) remain. Stays in-progress; needs architect spec for the harder traps.

## Architect spec pointer (2026-07-04)

The remaining hard pieces are now specced in the dynamic-MOP umbrella
**#3031** (`plan/issues/3031-dynamic-mop-extensions-spec.md`, Part 1):
standalone construct + dynamic-new dispatch = **K2** (FABLE); revocable
(S0) = **P3** (OPUS); `Reflect.*` wiring (S1) = **P4** (OPUS); §10.5
invariants + descriptor-attribute bits (G) = **P5**; host apply/construct
keystone = **K1** (== 2623-A, see #2618). The receiver-classification
ladder + front-guard mechanism is ratified in #3031 Part 0.
