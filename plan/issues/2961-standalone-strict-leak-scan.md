---
id: 2961
title: "Extend the strictNoHostImports leak guarantee to `--target standalone` (today wasi-only)"
status: in-progress
depends_on: [3009]
sprint: current
created: 2026-07-02
updated: 2026-07-16
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen
language_feature: compiler-internals
goal: standalone-mode
related: [2094, 2879, 2073, 2075, 2860, 3009]
origin: "2026-07-02 July Fable audit §3 (protection asymmetry: standalone has only the statistical floor, no structural guarantee)"
regressions-allow:
  count: 3150
  reason: "#2961's own purpose (reject host-backed standalone passes, ORACLE_VERSION 5->6) produces exactly this reclassification shape, anticipated in its own acceptance criteria. merge_group run 29532692021: 3084 non-excused wasm-change regressions, 100% one category (host_import_leak, no other present) -- leaky passes correctly becoming honest fails. Traps all decreased/flat (null_deref 339->251, illegal_cast 566->259, oob 43->41, unreachable 3->3), zero new. Net -3082 (27964->24882 standalone pass), 2 improvements. Ceiling: 3084 + ~66 margin."
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

## Re-scope (2026-07-02, after #3009 tracing)

Scoping this surfaced that the flip is **not** a one-line gate change, and that
the standalone leak surface is far narrower than the "7,498 pass-but-leaky"
headline suggested. Two findings:

1. **Most pure-language features are already host-free under `--target
standalone`.** Verified on current main (zero `env` imports emitted):
   arithmetic, classes/methods, string concat + coercion, `String()` /
   `.toString()`, `throw` / `Error`, `JSON.stringify`. So the naïve
   "flip strict on for standalone → huge baseline churn" fear is overstated;
   the leak set is a **specific, enumerable** list, not a pervasive one.
2. **The real blocker is a narrow CRASH hazard, not a leak-count problem.**
   Flipping strict on for standalone re-triggers the `absoluteFuncIndex`
   internal crash (`stable handle undefined (ordinal NaN)`) the moment a
   dropped host import is baked into a stable-handle helper body — e.g.
   `console.log(<string>)` → `__str_to_extern` → dropped
   `__str_from_mem`/`__str_to_mem`/`__str_extern_len`. That crash masks the
   real diagnostic and would make the enumeration lane unusable.

### 3-step decomposition

- **(a) Harden the degrade path — #3009 [LANDING].** Convert the
  dropped-stable-handle-coupled crash into a clean, named leak diagnostic.
  This unblocks the enumeration lane (a real leak now reports cleanly instead
  of crashing). This issue is `blocked` on #3009 landing.
- **(b) Enumerate the full standalone leak set.** With #3009 in, run the
  standalone lane (or a scoped example/test262 sweep) with the strict flag on
  and collect every host import name that now hard-errors. Classify each as
  (i) allowlist-with-retiring-issue, or (ii) `refuseStandalone*` loud error
  where no fallback exists. This produces the concrete, finite work list.
- **(c) Flip the strict gate for `ctx.standalone`.** Default
  `strictNoHostImports` on for standalone (mirroring wasi). Land
  **warning-severity first** if a hard flip regresses the host-free floor —
  every leak gets a source-located diagnostic — then ratchet to error once the
  allowlist stabilizes. End state = the same structural guarantee wasi has.

## Acceptance criteria

- `--target standalone` compile of a program using an un-allowlisted host
  import fails loudly at compile time (or warns, phase 1) — never emits a
  silently-trapping binary, and never crashes with the `absoluteFuncIndex`
  internal error (guaranteed by #3009).
- Allowlist growth for this issue is fully annotated (name → retiring
  issue).
- Host-free floor (check-standalone-highwater) net-neutral or up;
  merge_group validated.
