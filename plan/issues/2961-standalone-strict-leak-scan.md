---
id: 2961
title: "Extend the strictNoHostImports leak guarantee to `--target standalone` (today wasi-only)"
status: ready
sprint: current
created: 2026-07-02
updated: 2026-07-02
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen
language_feature: compiler-internals
goal: standalone-mode
related: [2094, 2879, 2073, 2075, 2860]
origin: "2026-07-02 July Fable audit §3 (protection asymmetry: standalone has only the statistical floor, no structural guarantee)"
---

# #2961 — `--target standalone` has no structural no-leak guarantee

## Problem

`strictNoHostImports` auto-enables **only for `--target wasi`**
(`src/codegen/context/create-context.ts:25`:
`options?.strictNoHostImports ?? options?.wasi ?? false`). Both enforcement
layers — the per-call allowlist gate in `addImport`
(`src/codegen/registry/imports.ts:51-75`) and the emit-time
`assertNoLeakedHostImports` scan (`src/codegen/index.ts:2230`) — key off
that flag. So a host import reaching `addImport` off the late-import
rerouting path under plain `--target standalone` is **emitted silently**
and traps at instantiation on a host-free runtime. The only protection is
the statistical `host_free_pass` CI floor. The audit measured 7,498
pass-but-leaky tests — this asymmetry is why that class can exist.

## Approach

1. Default `strictNoHostImports` on for `ctx.standalone` as well.
2. Expect baseline churn: run the standalone lane, enumerate every import
   name that now hard-errors, and either (a) add it to
   `src/codegen/host-import-allowlist.ts` **with its retiring issue id**
   (the existing budget discipline, `[allowlist-grow]` sign-off), or
   (b) convert the site to a `refuseStandalone*`-style loud compile error
   where a fallback is genuinely absent.
3. Severity option if a hard flip regresses the floor: land as
   warning-severity scan first (every leak gets a source-located
   diagnostic), flip to error once the allowlist stabilizes — but the end
   state is the same hard guarantee wasi has.

## Acceptance criteria

- `--target standalone` compile of a program using an un-allowlisted host
  import fails loudly at compile time (or warns, phase 1) — never emits a
  silently-trapping binary.
- Allowlist growth for this issue is fully annotated (name → retiring
  issue).
- Host-free floor (check-standalone-highwater) net-neutral or up;
  merge_group validated.
