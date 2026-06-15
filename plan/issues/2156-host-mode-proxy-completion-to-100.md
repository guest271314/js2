---
id: 2156
title: "Host-mode Proxy: close remaining test262 failures toward 100% (invariant checks, Wasm-typed targets, revocation lifecycle)"
status: ready
created: 2026-06-15
updated: 2026-06-15
priority: top
feasibility: hard
reasoning_effort: high
task_type: feature
area: codegen, runtime
language_feature: proxy
goal: spec-completeness
sprint: 63
related: [1466, 1100, 1355]
note: "2026-06-15: created + elevated to TOP priority by stakeholder (Proxy/Promise/async-to-100% epic). #1466 (Proxy+Reflect trap fidelity, done) was the last host-mode Proxy issue; built-ins/Proxy still sits at ~23% (71/311). No tracker existed for the remaining host-mode failures — this is it. Needs architect triage of the failing buckets before dev dispatch."
---

# #2156 — Host-mode Proxy: close remaining test262 failures toward 100%

## Problem

In JS-host mode `new Proxy(target, handler)` and `Proxy.revocable()` delegate
to the host via `__proxy_create` / `__proxy_revocable` (see
`src/codegen/expressions/new-super.ts`, `src/codegen/expressions/calls.ts`).
After #1466 (Proxy + Reflect trap/operation fidelity, **done** 2026-06-12),
`built-ins/Proxy` conformance is still only **~23% (71/311 pass, 231 fail)**.

The remaining host-mode failures are **not tracked by any open issue** —
#1466 was the last one and it's closed; #1100/#1355 are the *standalone*
(pure-Wasm) Proxy track. This issue captures the host-mode tail so the
"Proxy → 100% in host mode" goal has a vehicle.

## Scope (host mode only)

Architect to triage `built-ins/Proxy` failures into buckets first. Known
suspect areas from prior analysis:

- **Invariant enforcement** — `[[Get]]`/`[[Set]]`/`[[GetOwnProperty]]` /
  `[[DefineOwnProperty]]` invariant `TypeError`s required by the spec when a
  trap result contradicts a non-configurable / non-writable target property.
- **Wasm-typed objects as Proxy targets** — a Proxy wrapping a compiler-typed
  struct (not a plain host object) must still route ordinary operations
  correctly through the trap → target path.
- **Revocation lifecycle** — operations on a revoked proxy must throw
  `TypeError`; `Proxy.revocable().revoke()` semantics and idempotence.
- **Trap receiver / argument fidelity** — argument arrays, receiver binding,
  and result coercion for the less-common traps (`ownKeys`, `getOwnPropertyDescriptor`,
  `defineProperty`, `deleteProperty`, `getPrototypeOf`, `setPrototypeOf`,
  `isExtensible`, `preventExtensions`).

## Acceptance criteria

- Architect triage doc: failing `built-ins/Proxy` tests bucketed by root
  cause, with per-bucket fix sizing.
- Host-mode `built-ins/Proxy` pass rate raised substantially toward 100%
  (target ≥90% of non-skipped; stretch 100%). Set concrete numeric target
  after triage.
- No regressions in `built-ins/Reflect` (currently ~72%) or elsewhere.
- Each fixed bucket has a probe under the issue-coverage rule.

## Notes

- This is the **host-mode** companion to the **standalone** Proxy track
  (#1100 Phase 1 + #1355 remaining traps). The two share trap-dispatch
  semantics; coordinate so the standalone meta-object protocol reuses the
  host-mode invariant logic where possible.
- All three Proxy issues (#2156 host, #1100 + #1355 standalone) are part of
  the 2026-06-15 stakeholder-elevated **Proxy/Promise/async → 100% epic**
  (see `plan/issues/sprints/63.md`).
