---
id: 1850
title: "Harden the IR verifier into a hard between-pass contract (cross-block dominance + per-backend legality + fail-CI)"
status: backlog
sprint: Backlog
created: 2026-06-04
updated: 2026-06-04
priority: high
feasibility: medium
reasoning_effort: medium
task_type: infrastructure
area: ir
language_feature: compiler-internals
goal: correctness
related: [1844, 1798, 1131, 1376, 1530]
---
# #1850 — Harden the IR verifier into a hard between-pass contract

**Source:** [`docs/architecture/compiler-design-lessons.md`](../../docs/architecture/compiler-design-lessons.md) — recommendation **R1** (P1).

## Problem

`src/ir/verify.ts` (`verifyIrFunction`) already enforces a strong subset —
SSA single-definition, use-before-def *within* a block, one terminator per
block, branch-arg arity against target signatures, symbolic-refs-only — and
is already invoked pre/post-pass in `integration.ts`. This is the right
backbone, but it has documented gaps that let whole bug classes through:

1. **Cross-block use / dominance is a Phase-2 TODO.** The header comment in
   `verify.ts` explicitly defers "every use is dominated by its def" across
   blocks. Until it lands, an SSA value used on a path where it isn't
   dominated by its definition is invisible to the verifier.
2. **No nested-buffer recursion** — already filed as **#1844** (verify
   doesn't recurse nested `if`/`try`/`loop` buffers; return-type gate + SSA
   holes, residual of #1798). This issue is the umbrella; #1844 is one slice.
3. **No per-backend legality check.** The verifier validates "is this valid
   IR" but not "is this IR legal for *this* target." A node legal under the
   WasmGC backend but illegal under linear memory (or vice versa) is only
   caught downstream as a malformed-Wasm validation failure, far from the
   producing pass.
4. **Verifier failure feeds the fallback, but isn't gated.** A verify
   failure on a claimed function silently demotes to legacy; it should also
   surface as a hard-error (see #1853 / R6) so it can't mask a real IR bug.

## Recommendation

Treat the verifier as a hard contract: every pass assumes valid input and
must produce valid output; a verify failure is attributed to the producing
pass. Keep checks **local** (don't walk def-use chains for unrelated
invariants); when many passes re-check the same thing, push it into the
verifier or into the `IrType` (see #1851/R2).

## Acceptance criteria

- [ ] `verifyIrFunction` checks **cross-block dominance** (every use is
      dominated by its def along all CFG paths), closing the Phase-2 TODO.
- [ ] Nested if/try/loop buffer recursion lands (absorbs **#1844**).
- [ ] A **per-backend legality pass** runs at the emit boundary for each
      `BackendEmitter` (WasmGC / linear / bytecode), rejecting IR that uses
      ops/types not legal for that target with a clear, localized error.
- [ ] In test/CI builds, a verifier failure on a **claimed** function fails
      the build (lands in the hard-error stability bucket of #1853), rather
      than silently demoting.
- [ ] Equivalence + test262 suites stay green; no new fallback-budget growth.
