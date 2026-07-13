---
id: 3247
title: "FinalizationRegistry JS-host mode: lowered as host-dep extern class instead of no-op stub (regressed #1600)"
status: ready
created: 2026-07-13
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bug
area: codegen+runtime
language_feature: FinalizationRegistry
goal: npm-library-support
sprint: Backlog
related: [1600, 1101]
es_edition: ES2021
---
# #3247 — FinalizationRegistry JS-host mode regressed to host-dep extern class

## Problem

`tests/issue-1600.test.ts` → `compiles new FinalizationRegistry + register/unregister
in JS-host mode` FAILS on current main (verified at c0cc5c3b, 2026-07-13):

```
Error: No dependency provided for extern class "FinalizationRegistry"
  ❯ isWrapperCtor src/runtime.ts:7506:19
  ❯ fn src/runtime.ts:14248:27
  ❯ __module_init wasm:/wasm/...
```

The test compiles a module with a top-level `new FinalizationRegistry(cb)` and
instantiates it with `buildImports(r.imports, undefined, r.stringPool)` — i.e.
**no host FinalizationRegistry dependency injected**. Per the #1600 spec
("FinalizationRegistry: host-delegate (JS mode) + no-op standalone stub"), in
JS-host mode FinalizationRegistry should either host-delegate OR fall back to a
**no-op stub** — it should NOT hard-require a host-provided constructor. It is
now being lowered as a host-dep-requiring extern class, so `isWrapperCtor`
resolves no `Ctor` and installs the throwing shim, which fires at
`__module_init`.

## Scope / priority

- **JS-host mode only.** The standalone (`--target wasi`) test and the WeakRef
  no-regress test both PASS. This is OFF the standalone `host_free` conformance
  path.
- **NOT the object-identity `===` regression.** #3006 (builtin-constructor
  identity) is fully green after #3031; this is a separate, pre-existing
  JS-host dependency-injection gap surfaced during that verification.
- `priority: low` — #1600 itself was priority:low.

## Repro

```ts
// tests/issue-1600.test.ts already reproduces:
var reg = new FinalizationRegistry((v) => {});
reg.register({}, 1);
reg.unregister(1);
export function test(): number { return 1; }
// compile({ target default JS-host }) then buildImports(imports, undefined, pool)
// → throws "No dependency provided for extern class FinalizationRegistry" at init
```

## Fix direction (not yet implemented)

In `src/runtime.ts` `isWrapperCtor` / the extern-class resolution path
(~line 7506), FinalizationRegistry (and likely the other GC-observer classes it
groups with) should fall back to the no-op stub the #1600 spec calls for when no
host dep is provided in JS-host mode, rather than installing the throwing shim.
Confirm the lowering change that flipped it from stub → hard extern-class (the
`isWrapperCtor` throw path is longstanding; the regression is upstream — what
now routes FinalizationRegistry through it at module_init).
