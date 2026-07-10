---
id: 3009
title: "Harden host-import degrade path: dropped stable-handle-coupled import must yield clean leak diagnostic, not absoluteFuncIndex crash"
status: done
sprint: 69
created: 2026-07-02
completed: 2026-07-02
updated: 2026-07-03
assignee: ttraenkler/agent-a840cb644c42d6eab
priority: medium
horizon: m
feasibility: medium
task_type: fix
area: codegen
language_feature: compiler-internals
goal: standalone-mode
related: [2961, 2094, 2879]
origin: "2026-07-02 — traced while scoping #2961 (extend strictNoHostImports to --target standalone)"
---

# #3009 — harden the strict-mode host-import degrade path against the `absoluteFuncIndex` crash

## Problem

Under `--target standalone` + `strictNoHostImports`, `console.log(<string>)`
lowers to `console_log_string(externref)` plus the `__str_to_extern` native
bridge (`src/codegen/native-strings.ts:7281-7308`). That bridge bakes calls to
the late imports `__str_from_mem` / `__str_to_mem` / `__str_extern_len`, none of
which are on the dual-mode allowlist (`src/codegen/host-import-allowlist.ts`).

With the strict gate ON, `addImport` (`src/codegen/registry/imports.ts:51-75`)
drops those three imports (pushing a `degrade` diagnostic) and leaves `funcMap`
unset for them, so `ensureLateImport(...)!` returns **`undefined`**. The bridge
bakes that into its helper body as `{ op: "call", funcIdx: undefined }`. At
finalize, `absoluteFuncIndex` (`src/emit/resolve-layout.ts:132`) hard-throws:

```
Codegen error: absoluteFuncIndex: stable handle undefined (ordinal NaN) has no recorded position
```

— an opaque **internal-compiler-crash** message, not a user-actionable leak
diagnostic. This is valuable to fix independent of #2961: ANY strict-mode
leak-drop scenario coupled to a stable func handle baked into another helper's
body can hit this crash today.

## Fix

Turn the crash into a clean, actionable leak diagnostic that names the coupling:

1. `src/codegen/registry/imports.ts` — when the strict gate drops a **func**
   import, record `{module, name}` on `mod.strictDroppedHostImports` (new field,
   `src/ir/types.ts`). Runs only inside the existing strict-drop branch, so all
   non-strict / non-dropping compiles are byte-inert.
2. `src/emit/resolve-layout.ts` — `absoluteFuncIndexCached` now detects a baked
   `funcIdx` of `undefined` / `null` / `NaN` (the dropped-import fingerprint,
   distinct from a genuine unrecorded stable handle) and throws a clean message
   that names the dropped-and-coupled import(s) from `mod.strictDroppedHostImports`,
   explains the standalone-strict degrade coupling, and points at #2961/#3009.
   The `generate*` try/catch prefixes `Codegen error:` and flips
   `result.success` to false — the degraded binary is never handed to a consumer.

The fix does NOT try to make `console.log` work under standalone strict mode
(that is #2961's larger scope) — it only converts the internal crash into a
clean, named leak diagnostic.

## Acceptance criteria

- [x] `console.log("...")` under `--target standalone` + `strictNoHostImports`
  fails with a clean diagnostic naming `env.__str_from_mem` /
  `env.__str_to_mem` / `env.__str_extern_len` — the opaque
  `stable handle undefined (ordinal NaN)` message is gone.
- [x] Byte-inert: gc, non-strict standalone, and wasi compiles are
  sha256-identical to origin/main (verified via a 7-case hash battery).
- [x] Regression test: `tests/issue-3009.test.ts`.

## Test Results

- `tests/issue-3009.test.ts` — 3/3 pass.
- Hash battery (gc-arith, gc-console, gc-class, standalone-arith, standalone-str,
  standalone-json, wasi-hello) — all 7 sha256-identical between origin/main and
  the patched tree.
- `npx tsc --noEmit` clean; `prettier --check` clean.
