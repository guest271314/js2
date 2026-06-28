---
id: 2768
title: "bare-var receiver recovery: per-type externref→ref recovery hardening + safelist expansion (follow-on of #2767's Date-only gate)"
status: ready
sprint: current
priority: medium
assignee: ttraenkler/unassigned
created: 2026-06-28
updated: 2026-06-28
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: methods, dynamic-dispatch, type-flow, property-access
goal: spec-completeness
related: [2767, 2151, 1888]
predecessor: 2767
horizon: m
---

# #2768 — bare-`var` receiver recovery: per-type hardening + safelist expansion

Follow-on of **#2767**. #2767 added `resolveAssignedNominalType` (recover the
nominal type a bare-`var`/`let` identifier holds when the TS checker reports
evolving-`any`) and substitutes it at the **call** dispatch hub so `var d; d =
new Date(0); d.toISOString()` dispatches.

#2767's first cut substituted for ANY recovered nominal and **failed the
`merge_group` test262 gate** — substituting `receiverType` across the ~10
nominal dispatch gates regressed 6 NON-Date receivers whose externref→ref
value-recovery is unguarded or whose native dispatch is partial. #2767 was
therefore narrowed to a **`SAFE_BARE_VAR_RECOVERY_NOMINALS` safelist (Date
only)** (`src/codegen/expressions/calls.ts`). This issue tracks **expanding that
safelist one type at a time**, each gated behind a full-CI / `merge_group`
validation, by first hardening that type's recovery path.

## The exact per-type recovery bugs (from #2228's merge_group delta)

Each is a bare-`var` (or recovered) nominal receiver routed into a dispatch path
that misbehaves. Fix the path, add the type to the safelist, validate via
`merge_group`:

| type | test262 evidence | failure | fix needed |
| --- | --- | --- | --- |
| **Promise** | `built-ins/Promise/prototype/finally/{rejected,resolved}-observable-then-calls-PromiseResolve.js` | `illegal_cast` in the recovered closure (`__closure_0`) | guard the externref→ref recovery (`ref.test` before `ref.cast`) on the Promise/thenable path |
| **RegExp** | `language/literals/regexp/y-assertion-start.js` (`re.test`) | wrong value (returns truthy `1` not `true`) | harden bare-var RegExp `.test`/method dispatch + boolean boxing |
| **SharedArrayBuffer / ArrayBuffer** | `built-ins/SharedArrayBuffer/prototype/grow/this-is-not-resizable-arraybuffer-object.js` | `.grow()` skips the spec TypeError | brand-check the recovered buffer receiver |
| **super-spread** | `language/expressions/super/call-spread-obj-spread-order.js` | `wasm_compile` (invalid Wasm) | the recovered super/closure receiver path emits invalid Wasm — needs the super-call lowering to tolerate the substituted type |
| **DisposableStack** | `built-ins/DisposableStack/prototype/dispose/throws-error-as-is-if-only-one-error-during-disposal.js` | `assertion_fail` | recovered dispatch path partial |

## Also folded in: property reads/writes (was the original #2768 scope)

Property **reads** (`d.field`) and **writes** (`d.x = …`) on a bare-`var`
receiver compute their OWN `receiverType` in `property-access.ts`
(`compilePropertyAccess`, the `objType = getTypeAtLocation(...)` site) — separate
from the call hub. Struct-field reads/writes ALREADY work (runtime value
recovery), so there is no Date-shaped win there; the divergent cases are
builtin property reads keyed on the static nominal symbol (`Map.size`,
`Set.size`, `ArrayBuffer.byteLength`, …). When a type is hardened + safelisted
above, also route the same `resolveAssignedNominalType` recovery through the
property read/write `objType` resolution, gated on the SAME safelist. (The same
unguarded-recovery regression risk applies — never substitute a non-safelisted
type.)

## Acceptance criteria
- For each type added to `SAFE_BARE_VAR_RECOVERY_NOMINALS`: its recovery path is
  guarded/correct, the cited test262 file(s) pass, and a full `merge_group` run
  shows net ≥ 0 with no new regression bucket.
- `resolveAssignedNominalType`'s var/let-only + all-assignments-agree + safelist
  guards remain intact.
- The shared helper may be hoisted to `shared.ts` so both the call hub and the
  property read/write paths import it (`calls.ts` imports from
  `property-access.ts`, so it cannot live in either without a cycle).

## Notes
- Do NOT remove any type from the safelist without a regression.
- Broad-impact (substituted `receiverType` flows into ~10 gates) → every safelist
  addition validates on full CI / `merge_group`, never a scoped sweep.
