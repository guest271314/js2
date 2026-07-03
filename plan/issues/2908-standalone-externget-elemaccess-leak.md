---
id: 2908
title: standalone obj[key] dynamic read leaks env::__extern_get (largest host-import leak class)
area: codegen-standalone
feasibility: hard
status: done
completed: 2026-07-01
assignee: ttraenkler/sdev-2908-externget-leak
related: [2748, 2879, 2372, 2572, 1472]
sprint: 69
priority: high
horizon: m
---

## Problem

`--target standalone` (pure-Wasm, no JS host) modules still emit an
unsatisfiable `env::__extern_get` HOST import for the ordinary dynamic
property-read pattern `obj[key]` / `obj.prop` on an `any`/externref receiver.
This is the **single largest standalone host-import leak class**
(`dynamic_object_property`): on the fresh merge_group standalone report at head
`20474543f` (run 28483020330, 2026-06-30), **4,514** tests import
`env::__extern_get`, of which **3,379** leak it as their _only_ `env::__*` host
import (1,733 pass, 1,636 fail). It is driven at scale by test262 harness code —
`propertyHelper.js`'s `verifyProperty` reads `obj[name]` on a generic `any`
receiver.

## Root cause (verified on current main, verdict (c))

`ensureLateImport(ctx, "__extern_get", …)` at every dynamic-read site _already_
routes `OBJECT_RUNTIME_HELPER_NAMES` (which includes `__extern_get`) to the
Wasm-NATIVE `ensureObjectRuntime` definition under `ctx.standalone || ctx.wasi`
(the #2748 WASI routing + the #1472 Phase B native `$Object` runtime). sr-dynobj's
native `$Object` reader is real and value-correct.

BUT the AST pre-scan `collectUsedExternImports` (`src/codegen/index.ts`, the
`ElementAccessExpression` arm ~line 13767) eagerly registered `env::__extern_get`
as a HOST import for **every** `obj[idx]` element-access on an externref-typed
receiver, with **no host-free-mode guard**. That seeded `__extern_get` into
`funcMap` BEFORE any read-site ran. `ensureLateImport` short-circuits on
`funcMap.has(name)` (returns the existing index without routing), so the
pre-seeded HOST import pre-empted the native routing and the module shipped the
unsatisfiable `env::__extern_get`.

So this is **distinct** from sr-dynobj's value-correctness fix (the native reader
exists and is correct) and from #2748 (which fixed the `ensureLateImport` WASI
routing but not the pre-scan). The pre-scan wins the race and the import leaks.
Confirmed by an `addImport` stack trace: the leak enters at
`collectUsedExternImports`'s element-access arm, with `ctx.standalone === true`
and `ctx.strictNoHostImports === false`.

## Fix

Guard the pre-scan host-import registration for `__extern_get` on
`ctx.standalone || ctx.wasi` — skip the eager `register("__extern_get", …)` in
host-free modes so the compile-path `ensureLateImport` binds the native
`ensureObjectRuntime` `__extern_get`. Host/gc mode is byte-identical (the guard
wraps the unchanged `register(...)` call).

`src/codegen/index.ts` — `collectUsedExternImports`, the `obj[idx]`-on-externref
arm.

## Verification (fresh data, head 20474543f)

- **GC/host byte-identity**: same input compiled `--target gc` is byte-identical
  pre/post fix (3919 == 3919 bytes) and still imports `env::__extern_get` there.
- **standalone**: the import is removed (main=leak, fix=host-free); the module
  grows (native `$Object` runtime now emitted inline) — the intended dual-mode
  tradeoff.
- **Corpus verify** (compile + instantiate + run `test()` via the runner's
  `buildImports`, fixed compiler):
  - 300 stratified baseline-pass leaky tests → 297 stay pass, **0** non-arguments
    fix-induced regressions (the 3 were `arguments-object`); all host-free.
  - 400 fresh non-arguments baseline-pass → 396 pass, **0 fix-induced
    regressions** (4 apparent CEs are pre-existing TS-level errors, byte-identical
    on main and fix — a local-harness artifact, not the fix).
  - 23 `arguments-object` leaky-pass → 14 stay pass, **9 flip pass→fail**: a
    pre-existing native mapped-arguments `[[DefineOwnProperty]]` descriptor gap
    the fully-native read path now _exposes_ (the old mixed host-read /
    native-descriptor path masked it). Tracked as follow-up **#2909**.
  - **0** tests still leaking `env::__extern_get` in any sample.

## Net accounting (standalone floor keys on host_free_pass, #2879 §4)

The floor gate (`scripts/check-standalone-highwater.mjs`) scores
`host_free_pass` (pass AND host-free), not raw pass. A leaky pass has
`host_free_pass = 0`. Therefore:

- ~1,710 non-arguments leaky-pass → host-free-pass ⇒ **Δhost_free_pass ≈ +1,710**
  (progress).
- ~9–13 `arguments-object` leaky-pass → host-free-fail ⇒ host_free_pass
  UNCHANGED (was 0, stays 0) — **does NOT breach the floor** (the exact
  "mid-flight carrier raw-pass dip" the #2879 §4 accounting anticipates).

Net: unambiguously NET-POSITIVE on the gated metric with zero floor breach.

## Tests

`tests/issue-2908-standalone-externget-elemaccess-leak.test.ts` — asserts
computed/named/verifyProperty-shaped/absent dynamic reads compile host-free
(`env` imports == []) and evaluate correctly in `--target standalone`.
