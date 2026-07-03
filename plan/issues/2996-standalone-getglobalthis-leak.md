---
id: 2996
title: "Eliminate env::__get_globalThis read leak in standalone mode (native globalThis value)"
status: done
completed: 2026-07-02
sprint: 69
priority: medium
horizon: m
assignee: ttraenkler/agent-af6e582225dfb945b
origin: plan/log/investigations/2026-07-02-leak-analysis-round5.md
---

## Problem

In standalone mode a bare `globalThis` identifier read compiles to the
`env::__get_globalThis` host import (`src/codegen/expressions/identifiers.ts`).
A no-JS-host binary can't satisfy that import, yet the standalone test262 runner
provides it, so the affected tests **pass but leak** the import
(`host_free_pass` excludes them).

Round-5 leak analysis (`plan/log/investigations/2026-07-02-leak-analysis-round5.md`)
ranked `env::__get_globalThis` as the **biggest genuine (execution-verified,
non-vacuous) sole-import lever: 47 sole-import leaky-passes**. Clusters:

- annexB `emulates-undefined` (15) — `$262.IsHTMLDDA` shapes
- Array/prototype `create-proto-from-ctor-realm` (10) — `$262.createRealm().global.X`
- Proxy `*-realm` (9) — `$262.createRealm().global.Proxy`
- `global-code` / eval-realm / BigInt cross-realm / module-code (rest)

### Root cause

Every one of the 47 tests uses `$262`, so the test262 runner prepends the
harness stub `let $262: any = { global: globalThis, … }`. Compiling that object
literal evaluates the `globalThis` initializer → emits `__get_globalThis`.
**None of the 47 tests ever READ a property off that `globalThis` value** — the
cross-realm tests read off a _fresh_ `createRealm()` realm object, not
`$262.global`. So the import is a pure artifact of needing `globalThis` to be a
valid object _value_.

## Fix

In standalone / WASI mode, resolve a bare `globalThis` identifier to a native,
lazily-created, cached `$Object` singleton (built with the same native
`__new_plain_object` runtime an empty `{}` uses — zero host imports), instead of
the `__get_globalThis` host import. The singleton is cached in a module global
`$__native_globalThis` (populated lazily once via `__new_plain_object`), so every
read returns the same Wasm-level externref. Host/gc mode is byte-identical (keeps
the host import).

(Note: standalone `===` on `any`-boxed objects doesn't currently observe ref
identity — a pre-existing general limitation, not specific to globalThis — so
`globalThis === globalThis` evaluates like `{} === {}` does today. None of the 47
tests rely on globalThis identity.)

New helper `emitNativeGlobalThisObject` in `src/codegen/array-object-proto.ts`
(modelled on `emitTypedArrayIntrinsicCtorObject`), called from
`compileIdentifier` in `src/codegen/expressions/identifiers.ts`.

### Scope boundary

READ-_value_ substrate only. Reflective READS of specific global bindings
(`globalThis.Array`, the defineProperty-on-globalThis own-property table) are the
much larger MOP work **deferred to #2988**; the `globalThis.prop` property-access
path (`src/codegen/property-access.ts`) is untouched here (host/gc keeps
`__extern_get(__get_globalThis(), key)`; standalone still leaks there, tracked
separately).

## Acceptance criteria

- Bare-`globalThis` sole-import `__get_globalThis` standalone tests compile with
  **zero `env::` imports** and still pass.
- Host/gc mode byte-identical (globalThis keeps `__get_globalThis`).
- No standalone regressions.

## Test Results

Measured against the round-5 merged-report list of 47 sole-import
`__get_globalThis` standalone leaky-passes (`origin/main` `4c74c87`):

- **All 47 still PASS in standalone** (execution-verified via
  `runTest262File(..., "standalone")`).
- **40 / 47 now compile with ZERO `env::` imports** (host-free) — the bare
  `globalThis`-value shapes: annexB `emulates-undefined` (15),
  Array/Proxy/BigInt cross-realm `$262.createRealm().global.X` (20),
  `global-code` `$262.evalScript` (2), eval-realm/module-code tail (3).
- **Host/gc mode byte-identical** — the new path is gated on
  `ctx.standalone || ctx.wasi`; gc still emits `__get_globalThis` (confirmed).

### Residual (7) — property-access READ path, out of scope here

7 tests still leak `__get_globalThis` because they READ `globalThis.<prop>`
(the `compilePropertyAccess` `globalThis.prop` → `__extern_get(__get_globalThis(),
key)` path, deliberately untouched):

- 6 × `language/eval-code/direct/arrow-fn-*` — read `globalThis.arguments`
  (would convert to a native-object read; low value, eval-adjacent).
- 1 × `language/module-code/export-expname-import-string-binding.js` — reads
  `globalThis.Mercury`, a **real exported global binding**. A native empty
  globalThis can't serve this — it needs the actual own-property table, which is
  the deferred **#2988** MOP substrate. Converting the property-access path
  without that would regress this test (pass → fail), so it's left host-backed.

These 7 are unaffected by this change (they don't use the bare-`globalThis`
identifier path) — still passing, no regression.
