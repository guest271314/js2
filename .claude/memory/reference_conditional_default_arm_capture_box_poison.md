---
name: reference_conditional_default_arm_capture_box_poison
description: "A call-expression/IIFE/generator default compiled inside a CONDITIONALLY-SKIPPED arm materializes its capture box on the not-taken branch — poisons captured-var reads; gate such lowering to pure literal/identifier defaults"
metadata:
  node_type: memory
  type: reference
  originSessionId: 12c43077-c2b6-4d65-be90-38a24eecc6a6
---

When a default initializer is lowered **inside a conditionally-skipped arm**
(the default only fires when the destructured element / value is missing), a
default whose value is a **CALL expression** — IIFE, generator `g()`, or any
capturing helper — still emits its **capture-box materialization** on the
*not-taken* branch. That corrupts later reads of the captured variable
(#2692 closure-box-lazy) and **over-consumes generators** (#2566). When the
element is PRESENT the default must not run at all, but the emitted call-default
code path still initializes the box.

Concrete instance (#2669 / PR #2124, merged 2026-06-26): a for-of / for-await
nested-array destructuring default fix applied the default for ALL initializers.
The `ary-ptrn-elem-ary-elision-{init,iter,empty}` for-await tests (element
PRESENT, default must NOT fire) regressed — 12 assertion_fail — because the
call-expression default arm poisoned the capture box. **Safe fix = gate
nested-pattern default lowering to pure literal/identifier values only:**
`element.initializer !== undefined && !stmt.awaitModifier && !ts.isCallExpression(element.initializer)`
A literal/identifier default has no side effect and no capture box, so it is
safe to evaluate conditionally. Call-expression nested defaults stay deferred
until the #2692/#2566 substrate (eager box materialization + generator
non-over-consumption) generalizes. The forgone case is documented in #2669 and
cross-referenced from #2566.

Two process lessons reinforced:
- **Host-masked / merge_group-only:** these flipped rows only surface in the
  merged-state FULL test262 (the #2097 merge_group floor); a scoped 1,781-dstr-
  file sweep + PR-level CI were all green. [[project_standalone_floor_only_on_merge_group]]
- **Verify-first beat the prime-suspect guess:** the shared `__vec_get` /
  boxToExternref change was NOT the culprit — the for-of nested-default arm was.
  Pull the actual flipped-row delta (`/analyze-regression` vs the merge-report
  jsonl) before trusting any a-priori suspect. [[reference_single_pr_merge_group_refail_is_real_not_drift]]

Generalizes beyond dstr defaults: any conditional-emission context with a
side-effecting/capturing arm (optional chaining, `??=`, conditional exprs) can
hit the same not-taken-arm box-materialization poison.
