---
id: 3145
title: "standalone: Atomics.* on non-shared views (the non-SAB subset — ~29 __get_builtin CEs)"
status: in-progress
assignee: ttraenkler/senior-dev-a7a4
sprint: current
priority: medium
horizon: m
feasibility: medium
area: codegen, runtime
goal: standalone-mode
related: [2984]
origin: "#2984 __get_builtin cluster triage (fable-sub1, 2026-07-11)"
---

# #3145 — standalone Atomics.* on non-shared views (non-SAB subset)

## Problem

`Atomics.add/sub/and/or/xor/store/exchange/compareExchange/notify/wait/waitAsync`
used as a standalone value/call hard-CEs through the `__get_builtin`
dynamic-shape refusal (#1472 Phase B) — measured **312** non-pass standalone
entries mentioning `__get_builtin` under `built-ins/Atomics/`.

## Scope caution (measured 2026-07-11)

**Only ~29 of the 312 are in scope.** 283 require `SharedArrayBuffer`, which is
on the standalone/test262 skip list (see CLAUDE.md skip filters:
SharedArrayBuffer) — those are out of scope until SAB itself is supported. The
**in-scope 29** are the *non-shared* error-path tests, which only need
`Atomics.*` to be a resolvable builtin that throws the spec `TypeError` when
handed a non-shared integer view (i.e. no real shared-memory semantics needed —
just the recognizer + the throw-on-non-shared branch).

## Sample paths (in-scope, non-SAB)

- `test/built-ins/Atomics/sub/non-shared-int-views-throws.js`
- `test/built-ins/Atomics/add/non-shared-int-views-throws.js`
- `test/built-ins/Atomics/store/non-shared-int-views-throws.js`
- `test/built-ins/Atomics/notify/retrieve-length-before-index-coercion-non-shared.js`
- `test/built-ins/Atomics/waitAsync/null-bufferdata-throws.js`
- `test/built-ins/Atomics/waitAsync/bigint/null-bufferdata-throws.js`

## Shared-infra deps

- The `Atomics` namespace must resolve as a builtin under standalone (today it
  falls to `__get_builtin`). A minimal recognizer + spec `TypeError` on
  non-shared / null-buffer receivers likely flips all ~29 without real atomic
  ops. Confirm the exact count against current main before sizing.

## Acceptance

- The ~29 non-SAB `built-ins/Atomics/*` error-path tests compile + pass on the
  standalone lane; 0 regressions on a passing-test sweep. SAB-dependent tests
  stay skipped (out of scope).
