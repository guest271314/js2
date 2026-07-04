---
id: 2870
title: "Standalone exception-message formatter throws on Wasm-GC payload, masking real failure signatures"
status: done
assignee: ttraenkler/sendev-ci
completed: 2026-06-30
created: 2026-06-30
priority: high
task_type: bug
area: tooling
goal: standalone
sprint: 69
horizon: s
related: [2862, 2860]
---

# Standalone exception-message formatter throws on a Wasm-GC payload

## Problem

`extractWasmExceptionMessage` (`tests/test262-runner.ts:2913`, and the CI copy in
`scripts/test262-worker.mjs:872`) formats a thrown value with `String(payload)`.
In `--target standalone` the thrown value is frequently a **Wasm-GC error struct**
(an `anyref` with no JS-reachable `toString`), so the **host** `String()` /
`ToPrimitive` itself throws `TypeError: Cannot convert object to primitive value`.
That host TypeError escapes the formatter and is recorded as the test's failure —
**masking the real signature** (the genuine in-Wasm throw/trap) behind a phantom
formatter error.

### Impact

~2,014 standalone-only failures are mis-recorded with the
`Cannot convert object to primitive value` signature (the single largest standalone
signature). They are **heterogeneous** real failures (number→string key coercion,
`ToIndex` object coercion, getter reflection, `propertyHelper` formatting, …)
collapsed onto one masking string — see the verify-first finding in #2862. This
makes the standalone gap measurement dishonest and blocks accurate cluster triage.

## Root cause

`String(payload)` is unguarded. When `payload` is a Wasm-GC struct the host
ToPrimitive throws, and the throw propagates out of `extractWasmExceptionMessage`.

## Fix

Guard every `String(payload)` / `String(err)` in `extractWasmExceptionMessage`
(both the runner and the CI worker copy) so the formatter NEVER throws — on
failure fall back to a stable label (`uncaught Wasm-GC exception (non-stringifiable
payload)`) instead of letting the host TypeError escape.

**Error-text only — flips ZERO pass/fail.** The test still fails; it just records
the REAL signature now instead of the masking TypeError. The standalone-floor
(pass count) and the regression gate (pass→fail transitions) are therefore
unaffected — verified before/after.

## Test plan / acceptance

- Verify-first: a standalone test that threw a non-stringifiable Wasm-GC payload
  no longer records `Cannot convert object to primitive value`.
- Confirm ZERO pass→fail or fail→pass movement on the standalone sample.
- Full `merge_group` + standalone high-water shows no floor movement.
- Follow-up (separate): re-triage the unmasked ~2,014 into real sub-clusters for
  arch to re-file #2862 as actual fixable clusters.
