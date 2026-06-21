---
name: project_2552_annexb_phase2_narrowed
metadata: 
  node_type: memory
  type: project
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

#2552 = rework of the reverted Annex B B.3.3 **Phase 2** (case-B outer
var-binding lifecycle + `typeof F` runtime resolution). Original PR #1769
pre-allocated the outer-binding TDZ var (externref local + i32 flag) for EVERY
structurally eligible block-nested function → perturbed local-index layout for
the dominant test262 harness shape (a fn that merely *contains* a block-nested
helper) → full gate **-1180** (`wasm_compile`/`null_deref` in `Array/prototype`
+ dstr) → reverted at `925db38df`, Phase-1-only landed.

**Fix (PR #1817, mine):** reapplied the reverted source (inverse of 925db38df:
`context/types.ts` `annexBOuterBindings`, `statements.ts` decl-site init,
`nested-declarations.ts` eligibility+alloc, `typeof-delete.ts`
`emitAnnexBTypeofFlagBranch`) and **narrowed** `annexBBlockNestedEligible` with a
new `annexBNameObservedOutsideBlock(name, block)` gate — allocate the outer
binding ONLY when the block-fn name is referenced as a value outside its
declaring block. Unobserved (the harness shape) → byte-identical to pre-Phase-2.

**How to apply / verify this class:** for hot-path-regression reworks, the
decisive local proxy is **compile-and-hash byte-identity** of the regressing
shapes (branch vs clean upstream/main, via `git stash push -- src/` in the
single-owner worktree, recompile, sha256 the base64 binary, pop). Verified
identical on single/multi-helper, dstr, nested-block, and a realistic
Array.prototype verifyProperty harness. The -1180 can't be reproduced in targeted
local compiles (it lives in test262 harness/strict config) — the **full
test262-regression gate is the final arbiter**, byte-identity is the proxy. On
gate net ≥ 0, #2200 closes (both phases). JSDoc gotcha: never put `*/` (e.g.
`*/dstr`) inside a block comment — it closes the comment and cascades TS1443.
See [[project_fork_origin_behind_upstream_pr_base]].
