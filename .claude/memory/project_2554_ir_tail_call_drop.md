---
name: project_2554_ir_tail_call_drop
metadata: 
  node_type: memory
  type: project
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

#2554 (orig "the #54 IR tail-call regression" — no issue file existed; reproduced
on upstream/main and filed). A **top-level** self-recursive fn in tail position
overflowed the Wasm stack on deep recursion, while the **same fn nested** inside
another did NOT (same depth, host + standalone).

**Root cause:** the legacy AST return path rewrites a tail `return f(...)` into
`return_call`/`return_call_ref` (`maybeEmitTailCall`, `src/codegen/statements/
control-flow.ts`; #602). The IR `return` lowering (`src/ir/lower.ts`) emits
`<operands>; return` and never does this — so IR-claimed fns (top-level decls are
the most IR-claimable shape) lost TCO. Nested fns fall to legacy and keep it →
the top-level-vs-nested split.

**Fix (PR #1822):** new `src/codegen/ir-tail-call.ts` `applyIrTailCalls`, called
in `src/ir/integration.ts` right before the lowered body is committed to
`ctx.mod.functions` (where full module type info is available — the IR
`lowerIrFunctionBody` trait layer does NOT have ctx/mod, so the conversion can't
live inside lower.ts safely). Rewrites `<call|call_ref>; return` →
`return_call|return_call_ref` at any tail position (top-level + if/block/loop
arms), with the legacy guards: param-count match (#822), return-type match
ref/ref_null-compatible (#839), and NEVER descend into `try` (callee throw must
not escape the catch — #1972).

**How to apply / verify:** validate TCO by RUNNING deep recursion (overflow vs
correct value) with `instantiateWithRuntime`, not bare `{env:{}}` — the old
`tail-call-optimization.test.ts` + `ir-*-equivalence` suites have PRE-EXISTING
bare-import harness failures (`string_constants`/`__unbox_number` not provided),
identical on clean upstream; don't mistake them for regressions. **Dup-id
gotcha:** `--allocate` can lose a race if another agent's same-id issue lands
between allocation and push (mine: #2553 collided with a landed
2553-variable-spread; renumbered to #2554). The `check:issues` quality gate
catches it — fix by renumber, not retry. See [[project_2552_annexb_phase2_narrowed]].
