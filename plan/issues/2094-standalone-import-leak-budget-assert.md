---
id: 2094
title: "standalone import-leak budget + emit-time import-section assert (post-link scan, structured CE)"
status: done
sprint: 62
created: 2026-06-11
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/dv2
priority: high
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: compiler
language_feature: compiler-internals
goal: host-independence
related: [2073, 2075, 2089]
origin: "2026-06-11 analysis program (report 06 §4); stub 08-C9"
---

# #2094 — nothing scans the finished binary for leaked env imports

## Problem

Host imports leak past the strict `addImport` gate into standalone
binaries (instantiation failures #2073/#2075) via gate bypasses and stale
funcMap indices; nothing inspects the finished binary's import section.

## Root cause

`src/codegen/registry/imports.ts:34-46` gate is bypassable — its own
comment documents the stale-index hazard.

## Plan

(1) Post-link import-section scan under `--target standalone`: any
non-allowlisted `env` import → structured compile error naming the import
and the producing site. (2) Playground-corpus leak-budget test cloned from
tests/host-import-allowlist-budget.test.ts, baseline ratcheting down.
Leak counts feed the #2089 dashboard (class h).

## Acceptance criteria

- The #2073/#2075 repro classes produce CEs (or compile clean post-fix),
  never instantiation failures
- Leak-budget test in CI with committed baseline

## Dupe check

The #1888 refuse-loudly invariant covers addImport-time; emit-time
verification unfiled. New (analysis program).

## Resolution (2026-06-16, dv2)

**Emit-time post-link import scan.** `generateModule` (both finalize blocks
in `src/codegen/index.ts`) now calls `assertNoLeakedHostImports(ctx, mod)`
after `eliminateDeadImports(mod)` and after the late fixup passes, so the scan
runs over the *finished, live* import section. It is a no-op for host/WasmGC
builds; it fires under `ctx.strictNoHostImports || ctx.standalone`.

The scan itself lives in `src/codegen/host-import-allowlist.ts`:
- `scanForLeakedHostImports(imports)` — reuses the existing
  `isHostImportAllowed` decision and returns each non-allowlisted `env` import
  (`env-not-on-allowlist`) plus any non-`env`/non-WASI host-namespace import
  (`non-env-host-module`), de-duplicated.
- `buildLeakedHostImportError(leak)` — structured message that **names the
  import and the producing class** (stale funcMap index / direct mod.imports
  push) and is prefixed `Codegen error:` so the existing per-path bail in
  `compiler.ts` flips `result.success = false`. A leak now surfaces as a clean
  compile error instead of a #2073/#2075 instantiation failure.

Because the gate reuses the same allowlist as `addImport`, allowlisted host
imports (`console_*`, `Map_*`, `Promise_new`, `__box_*`, parseInt, …) and WASI
imports never false-positive.

**Leak budget = 0.** `tests/issue-2094-import-leak-scan.test.ts` pins the
scanner (allowlist/dedup/reason), the `Codegen error:` hard-fail message, and a
zero-leak budget over a representative standalone corpus (arithmetic, loops,
Math, strings, console, arrays, objects). The budget is a one-way ratchet —
any future leak of a non-allowlisted import fails CI.

### Acceptance criteria — met
- ✅ #2073/#2075 repro class now produces a `Codegen error:` (success=false),
  never an instantiation failure.
- ✅ Leak-budget test in CI (`tests/issue-2094-import-leak-scan.test.ts`) with
  a committed baseline of zero leaks over the standalone corpus.

### Files
- `src/codegen/host-import-allowlist.ts` — `scanForLeakedHostImports`,
  `buildLeakedHostImportError`, `LeakedHostImport`.
- `src/codegen/index.ts` — `assertNoLeakedHostImports` wired into both
  `generateModule` finalize paths.
- `tests/issue-2094-import-leak-scan.test.ts` — unit + e2e + budget.

### Test Results
- `tests/issue-2094-import-leak-scan.test.ts` — 13/13 pass.
- `tests/host-import-allowlist-budget.test.ts` — 2/2 (unchanged).
- Standalone regression batch (map/Set/number-fmt/string-imports/module-init/
  json-refuse) — 50/50 pass; no false positives from the new scan.
- `tsc --noEmit` — clean.
