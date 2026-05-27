---
id: 1674
title: "GetSetRecord set-like consumption: .size NaN, coercion count, has/keys callable checks"
status: ready
created: 2026-05-27
updated: 2026-05-27
priority: low
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: runtime
language_feature: set
goal: spec-completeness
sprint: Backlog
parent: 1659
---
# #1674 — GetSetRecord set-like consumption residuals

Split from #1659 (built-ins/Set investigation). ~53 fails in `built-ins/Set`,
all in the new Set methods' handling of an arbitrary **set-like argument**
(ES2025 §24.2.5.x `GetSetRecord`).

**Do NOT touch the `intent.className === "Set"` bridge in `src/runtime.ts`
(~line 2952)** — that bridge is correct (#1352/#1646). These residuals are in
the `GetSetRecord` shim that reads `size`/`has`/`keys` off the host argument.

## Buckets (current main 383ec0c6e)

| Cluster | ~count | Symptom | Likely cause |
|---------|--------|---------|--------------|
| `.size property is NaN` | ~17 | `set-like-array`, `set-like-class`, `allows-set-like-class` | the user `size` data-prop/getter isn't read + `ToNumber`-coerced before use |
| coercion count (`size-is-a-number`) | ~6 | `returned 5 @ L54` | `.size` read a wrong number of times; spec requires exactly one `Get(obj,"size")` + one `ToNumber` |
| `has`/`keys` not callable must throw (`has-is-callable`, `keys-is-callable`) | ~9 | `returned 3 @ assert#2 assert.throws(TypeError)` | when `.has`/`.keys` is not callable, GetSetRecord must throw TypeError; we don't |
| `string "has" is not a function` (`set-like-class-mutation`) | ~4 | runtime | method lookup returns a string instead of the function on set-like class instances |
| plain `Set.size` wrong (`returns-count-of-present-values`, `bigint-number-same-value`) | ~4 | `s.size` wrong after mixed inserts | size accounting / bigint-vs-number SameValueZero keying |

Out of scope: `proto-from-ctor-realm.js` (`$262 is not defined` — no realm host),
`is-a-constructor.js`, `prototype-of-set.js`, `prototype/forEach/this-arg-explicit.js`
(separate single-test causes).

## Direction

Implement `GetSetRecord(obj)` per spec: `Get(obj,"size")` once → if undefined
throw TypeError → `ToNumber` (NaN throws) → `Get(obj,"has")` must be callable
(else TypeError) → `Get(obj,"keys")` must be callable (else TypeError). Cache
the three reads in the record; the algorithm reads each exactly once. Then the
union/intersection/etc. drivers consume `record.has`/`record.keys` rather than
re-reading off the live object.

## Acceptance

- `.size NaN`, coercion-count, and has/keys-callable clusters pass.
- `built-ins/Set` pass-rate ≥ 90% (345/383).
- No change to the `intent.className === "Set"` bridge.
