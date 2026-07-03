---
id: 2952
title: "IR multi-exit control flow: labeled break/continue, switch (br_table), do-while, for-in adoption"
status: in-progress
assignee: ttraenkler/sr-multiexit
sprint: current
created: 2026-07-02
updated: 2026-07-03
priority: medium
horizon: l
feasibility: hard
reasoning_effort: max
model: fable
task_type: feature
area: ir
language_feature: statements
goal: ir-full-coverage
related: [2949, 2135, 2134, 2856]
origin: "2026-07-02 July Fable audit §1 (all six '(future)' direct-only statement rows share one structural blocker)"
---

# #2952 — six direct-only statement kinds share one structural blocker

## Problem

`plan/log/ir-adoption.md` lists SwitchStatement, BreakStatement,
ContinueStatement, DoStatement, LabeledStatement, and ForInStatement as
direct-only with "(future)" tracking — i.e. no issue. The July audit found
the shared root cause: the IR's hybrid control flow (top-level blocks with
return/br/br_if/unreachable terminators, but if/try/loop as instructions
with **nested buffers** — `forEachNestedBuffer`, `src/ir/nodes.ts:2057`)
has **no br_table and no multi-level labeled exit**. A `break lbl` from two
nested buffers deep, or a switch dispatch, cannot be expressed, so these
kinds are structurally unadoptable regardless of bucket work. Every pass
also pays a double-traversal tax (blocks + nested buffers).

Note: current fallback-bucket counts do NOT measure this (zero body-shape
rejects contain these kinds on the ratchet corpus) — this is a test262-scale
adoption blocker, not a playground-bucket one.

## Approach

Two candidate designs — pick in an architect-spec slice first:

- **A (incremental): exit-label depth on nested-buffer nodes.** Give
  `IrInstrIf`/`IrInstrLoop`/`IrInstrTryCatch` an optional label id; add
  `IrInstrBrLabel {label, depth}` + `IrInstrBrTable`; verifier rule: label
  targets must lexically enclose. Lowering maps to Wasm block/br depths
  (WasmGC and linear identically — core Wasm both).
- **B (structural): true CFG for these kinds** — larger, interacts with
  #2134 (effect model) and the passes' double-traversal tax; only if A's
  verifier rules turn out unsound for finally-interaction.

Then adopt kinds in order of test weight: do-while (rewrites to while —
cheapest), labeled break/continue, switch (br_table over dense i32 keys,
if-chain otherwise), for-in last (needs `__object_keys` iteration — pairs
with #2964).

## Acceptance criteria

- Architect spec recorded here (A vs B decision + verifier rules).
- do/labeled/switch rows move direct-only → mixed/ir-owned in
  ir-adoption.md (regenerated); claim-row-backed-by-lowering tests per kind.
- No new demote channel usage: kinds are claimed only when fully lowerable
  (capability.ts rows, not select.ts predicates — #2135 discipline).

## Implementation Plan (architect spec — 2026-07-03, sr-multiexit)

### Decision: **Design A (incremental exit-label depth), not B.**

Design B (a true multi-exit CFG for these kinds) is rejected as the primary
path. The measured shape of the IR (below) shows A is sound including the
finally-interaction case that the issue flagged as B's only justification,
and B would force the double-traversal-tax rewrite (#2134) as a prerequisite
— a far larger, higher-risk change for the same test262 yield. B stays on
the table ONLY as a fallback if a future kind needs a non-lexical exit
(none of the six do — JS `break`/`continue`/`switch` are all _lexically_
scoped, so a lexical label resolver is complete for them).

### What the IR actually is (measured, not assumed)

The IR is a **two-layer hybrid**, and the layers matter for this design:

1. **Basic-block CFG layer** — `IrBlock { instrs, terminator }` with
   `return | br | br_if | unreachable` terminators and `IrBranch{target,args}`
   block-args-as-phi. This layer ALREADY supports arbitrary forward/back
   branches between top-level blocks. `from-ast.ts` uses it for tail-position
   `if`/early-return.
2. **Nested-buffer layer** — `IrInstrIf` (short-circuit), `IrInstrWhileLoop`,
   `IrInstrForLoop`, `IrInstrForOf*`, `IrInstrTry` each carry self-contained
   `readonly IrInstr[]` buffers (`then`/`else`, `cond`/`body`/`update`,
   `catchClause.body`/`finallyBody`). The lowerer emits these to **structured
   Wasm** (`block`/`loop`/`if`/`try`) by recursion, WITHOUT touching the block
   CFG. `forEachNestedBuffer` / `mapNestedBuffers` (`nodes.ts`) are the single
   traversal/rewrite primitives; a `never`-check keeps every pass in parity.

**The structural blocker, precisely.** A loop already lowers to exactly the
frame shape break/continue need (`src/ir/lower.ts` `case "while.loop"`):

```
block            ;; Wasm depth d+1  ← `break` target
  loop           ;; Wasm depth d    ← `continue` target
    <cond>; i32.eqz; br_if 1        ;; normal exit
    <body>
    br 0                            ;; normal continue
  end
end
```

The frames exist. What is missing is any **IR instruction inside a nested
buffer that can branch to an enclosing structured frame**. A nested buffer
is emitted by recursion and does not know its own Wasm nesting depth, so a
`break` two buffers deep (e.g. inside an `if` inside the loop body) cannot
compute the relative `br` immediate. That — not the CFG layer — is the gap.

### Design A — the three pieces

**A1. Loop-carried label identity.** Add an optional `loopLabel?: IrLabelId`
to `IrInstrWhileLoop` / `IrInstrForLoop` / `IrInstrForOf*`, and a
`blockLabel?: IrLabelId` to a NEW `IrInstrLabeledBlock { kind:"labeled.block";
label; body: IrInstr[] }` used only for `LabeledStatement` wrapping a
non-loop (rare; a labeled `{ }` block that `break lbl` exits). `IrLabelId` is
a per-function-fresh branded number allocated by the builder from the source
`LabeledStatement`. Unlabeled loops carry no id; the from-ast layer
synthesises an internal id for the innermost loop so unlabeled
`break`/`continue` resolve through the same mechanism.

**A2. The branch instruction.** Add
`IrInstrBrLabel { kind:"br.label"; label: IrLabelId; mode:"break"|"continue" }`.
It is a **buffer-terminating** instruction (like `throw`): the verifier
requires it to be last in its buffer, or followed only by dead code it
prunes. NO `depth` is stored in the IR — depth is a _lowering-time_ artifact
(storing it in the IR would rot under any pass that re-nests buffers). This
is the key correction to the issue's sketch (which wrote
`IrInstrBrLabel{label, depth}`): **label is semantic, depth is derived.**

**A3. Lowering-time label→depth resolver.** Thread a `ctrlStack` through the
nested-buffer emitter in `lower.ts`. Each entry records the label(s) bound by
the Wasm frame the emitter is currently inside and its frame KIND:

```ts
type CtrlFrame =
  | { kind: "loop-block"; label: IrLabelId } // the outer `block` — break target
  | { kind: "loop-body"; label: IrLabelId } // the inner `loop`  — continue target
  | { kind: "plain" }; // if / try / labeled-block frame
```

Every structured frame the emitter opens (`block`, `loop`, `if`, `try`, and
each `catch`/`finally`) pushes one `CtrlFrame`; on close it pops. To lower
`br.label{label, mode}` the resolver scans `ctrlStack` from the top (depth 0
= innermost) and counts frames until it finds the entry matching `label` with
the frame kind the mode wants (`mode==="break"` → `loop-block`/labeled-block;
`mode==="continue"` → `loop-body`). That count is the Wasm `br` immediate.
This is O(depth) per branch, computed once at emit, and is IDENTICAL for
WasmGC and linear backends (core-Wasm `br` in both — no backend-specific
lowering, satisfying the #1852/#1527 axis rule).

**Verifier rule (A, sound — the finally caveat resolved).** `br.label` is
valid iff its `label` is bound by an enclosing loop/labeled-block **in the
same buffer nesting chain**, checked by a lexical walk that mirrors the
lowering `ctrlStack`. The finally-interaction the issue worried about is
handled WITHOUT a CFG: a `break`/`continue` that lexically crosses a `try`
with a `finallyBody` must run the finally first. Because `IrInstrTry`
lowering ALREADY inlines `finallyBody` at every abrupt-exit path (see
`nodes.ts` `IrInstrTry` doc — "inlined at every abrupt completion path"), the
resolver simply treats a crossed `finally` frame as an extra emission point:
when a `br.label` target lies OUTSIDE an enclosing `try/finally`, the lowerer
emits the finally buffer inline immediately before the `br`. This is the same
inlining the try lowering already does for normal completion — no new
control-flow machinery, which is exactly why A is sufficient and B is not
needed. (If a future construct required a finally to run on a branch that is
_not_ lexically nested — impossible for JS break/continue — only then would B
be forced.)

### Per-kind adoption order (each its own follow-up slice)

1. **do-while** — DONE this PR (slice 1). Reuses `while.loop` + `postCond`;
   needs none of A1–A3 because its body claims only the break/continue-free
   subset (same gate as the already-adopted `while`). This banks the cheapest
   row immediately and proves the selector↔lowering parity discipline.
2. **unlabeled break/continue** (A1 synth-id + A2 + A3) — unblocks the common
   loop-with-early-exit shape; by far the highest test262 weight. Selector:
   add a `break`/`continue` arm to `isPhase1BodyStatement` that accepts them
   only when an enclosing loop is in scope (track loop-depth in the walk).
3. **labeled break/continue** (A1 real ids + `labeled.block`) — extends #2 to
   named targets; `LabeledStatement` selector arm.
4. **switch** — `IrInstrSwitch { disc; cases:{test?,body}[]; default? }`
   lowering: `br_table` over dense i32 keys (fall-through = shared block
   tail), if-chain for sparse/string keys. `break` inside a case reuses the
   A2/A3 machinery targeting the switch's outer block.
5. **for-in** — last; needs `__object_keys` iteration, pairs with #2964.

Each slice flips its `ir-adoption.md` row and adds a
claim-row-backed-by-lowering test, exactly as slice 1 does here.

### Slice 1 (this PR) — do-while, implemented

- `src/ir/nodes.ts` — `IrInstrWhileLoop.postCond?: boolean` (post-test flag;
  no new kind → zero `forEachNestedBuffer`/`mapNestedBuffers`/verify/effects/
  propagate churn; every pass treats do-while as a while).
- `src/ir/builder.ts` — `emitWhileLoop({..., postCond?})`.
- `src/ir/from-ast.ts` — `lowerDoStatement` (builds a `postCond` `while.loop`),
  wired into both the top-level and body-statement dispatchers.
- `src/ir/lower.ts` — `case "while.loop"` post-test branch: emit body → cond
  → `i32.eqz; br_if 1`, then `br 0`; same `block{loop{}}` wrapper.
- `src/ir/select.ts` — `isPhase1DoStatement` (same shape rules as `while`;
  break/continue bodies rejected by `isPhase1BodyStatement`, so only the
  multi-exit-free subset is claimed — no post-claim demote).
- `plan/log/ir-adoption.md` — `DoStatement` direct-only → mixed (#2952).
- `tests/issue-2952.test.ts` — selector-claim + runtime tests, incl. the
  defining post-test semantic (`do{x++}while(false)` ⇒ 1, not 0) and the
  break-rejection boundary.

**Safety note (why sharing `while.loop` is sound).** The verifier walks a
loop's `cond` buffer before its `body` only to register `condValue`'s def
ahead of its use. A do-while body never has a cross-buffer SSA dependency on
the cond buffer (each buffer's SSA values are buffer-local; the only shared
state is outer-scope slots/locals), so the cond-first walk order is correct
for both pre-test and post-test loops. Only the lowering emission order
differs.

## Test Results (slice 1)

- `tests/issue-2952.test.ts` — 5/5 pass (selector claim, post-test-once,
  counted bound, nested-in-while, break-rejection).
- `tests/issue-1280.test.ts` (while/for) + `tests/issue-2136.test.ts`
  (numeric-truthiness loops) + `tests/issue-1169n.test.ts` — 35/35 pass (no
  regression to existing loop adoption).
- `pnpm run check:ir-fallbacks` — OK (no unintended/post-claim bucket growth).
- `npx tsc --noEmit` — clean (no exhaustiveness breakage; shared kind).
- Pre-existing unrelated failure `tests/ir-if-else-equivalence.test.ts`
  (`env "__unbox_number" requires a callable` — a harness import-stub gap)
  confirmed identical on clean `origin/main`; not touched by this slice.
