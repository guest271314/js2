---
id: 2988
title: "Standalone defineProperty on the global object (~10, needs global-object own-property MOP)"
status: done
assignee: ttraenkler/sr-globaldefine
completed: 2026-07-03
sprint: 69
priority: low
horizon: l
feasibility: hard
area: codegen, runtime
goal: standalone-mode
depends_on: []
related: [2965, 2907, 2984]
origin: "#2965 descriptor-cluster triage — follow-up class 5 (global-object receivers)"
---

# #2988 — standalone defineProperty on the global object

## Problem

Follow-up from #2965. ~10 tests do `defineProperty` on the global object
(top-level `this`) and fail on standalone.

## Status (corrected 2026-07-02)

**#2907 has landed** (upstream/main commit `fc61cf7d8`, PR #2406) — the
formal `depends_on: [2907]` blocker is cleared. But re-verification found
the underlying capability still doesn't exist: #2907 delivers well-known-global
**bare-value carriers** (read access to `globalThis`-scoped bindings), not a
**global-object own-property table**. Probing
`Object.defineProperty(globalThis, k, desc)` under `--target wasi` +
`strictNoHostImports` still compiles but leaks `env.__get_globalThis` +
`env.__extern_get` (+ box/unbox) — there is no reified global object with
own-property slots to define onto.

This is the **same substrate family as #2984** (standalone gOPD-on-builtin):
both need a real object-shaped MOP for a receiver that today is only
ad-hoc host-backed (builtin methods/constructors for #2984; the global
object for #2988). Read #2984's spec-seed (PR #2523) before scoping this —
the reification design there likely generalizes to the global object as a
degenerate case (one singleton receiver instead of N builtin receivers).

Re-scoped `ready` / `horizon: l` (was `blocked` / `m`) to reflect the real
remaining work. `depends_on` cleared since #2907 is not the active blocker.

## Acceptance

- `Object.defineProperty(globalThis, k, desc)` at top level defines a
  global own property observable by later reads / gOPD; measured flip count with
  zero regressions; gc/host byte-inert; zero `env::` leaks in standalone.

## Resolution (2026-07-03)

**Re-measurement flipped the framing.** The issue text (2026-07-02) said this
needs "the much larger MOP work" — a reified global own-property table. That was
already **built** by #2996 (`emitNativeGlobalThisObject`, a lazily-created cached
native `$Object` singleton) plus the standalone object runtime
(`ensureObjectRuntime`, which makes `__extern_get` / `__extern_set` /
`__define_property` DEFINED native helpers). Measuring on current main
(`bc8a1d4ca`) with `target: standalone` + `nativeStrings`:

- `Object.defineProperty(globalThis, k, desc)` — **host-free already** (the
  `globalThis` arg reads as the native singleton; `defineProperty` lowers to the
  native `__define_property` on it).
- `globalThis.x = v` write, then read via `(globalThis as any).x` — **host-free**,
  round-trips through the SAME singleton (define + write + gOPD all land in it).

**The one real gap** was narrower than the MOP framing: the reflective bare
`globalThis.prop` **member-READ** path (`compilePropertyAccess`,
`src/codegen/property-access.ts` ~L4021) hardcoded
`__extern_get(__get_globalThis(), key)` **ungated on mode**, so standalone/WASI
leaked the sole `env::__get_globalThis` import (unsatisfiable in a no-JS-host
binary). `(globalThis as any).prop` avoided it only because the `as any` cast
bypasses the `ts.isIdentifier(expr.expression)` special-case and dispatches
through the any-receiver path (native `__extern_get` on the singleton).

### Fix

In `compilePropertyAccess`'s `globalThis.prop` branch, resolve the receiver
dual-mode:
- **host/gc**: `__get_globalThis()` host import (unchanged).
- **standalone/WASI**: push the native singleton via `emitNativeGlobalThisObject`
  (the same one define/write use), then `__extern_get` — which is already a
  DEFINED native helper (routed by `ensureLateImport` → `ensureObjectRuntime`).
  Falls back to the host import if the object runtime is unavailable.

**Why this is the whole fix and not a symptom patch:** the substrate (singleton +
native own-property table + native `__extern_get`) already existed and already
served define / write / gOPD / any-receiver-read; only this one member-read
site failed to route to it. `__extern_get` and the `__unbox_number` coercion tail
were *already* native in standalone (`ensureLateImport` lines ~404/408 route
`UNION_NATIVE_HELPER_NAMES` and `OBJECT_RUNTIME_HELPER_NAMES` to native), so
`__get_globalThis` was the lone leak.

### Downstream-effect verification

- **Import-registration order preserved** for the host/gc path
  (`__get_globalThis` before `__extern_get`, as before) so host-import indices
  don't shift → host/gc byte-identical. Confirmed by sha256 over a 5-snippet
  corpus in both gc and host modes: **byte-identical** pre/post; standalone
  hashes change only where `globalThis.prop` appears (`no-gt` snippet unchanged).
- **Leak-elimination proof**: standalone binaries instantiate with an **empty
  import object `{}`** and return correct values (42, 5) — any residual `env::`
  import would throw at instantiate. `envImports(binary)` asserts `[]`.
- **No regressions**: the 11 globalThis/object-touching test files were run
  pre/post; the 7 failures (issue-779c `Array.prototype.constructor`, issue-1500
  fetch host imports ×5, issue-1492 crypto ImportIntent) **all reproduce on the
  pre-change source** — pre-existing, host-import/environmental, unrelated.

Regression test: `tests/issue-2988.test.ts` (WASM import-section parser +
functional round-trip + host/gc-unchanged assertion).
