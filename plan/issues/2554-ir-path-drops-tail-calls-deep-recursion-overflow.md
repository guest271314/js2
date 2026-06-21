---
id: 2554
title: "IR path drops tail calls on top-level recursive functions → deep-recursion stack overflow (regression vs legacy)"
status: done
sprint: 64
created: 2026-06-21
completed: 2026-06-21
assignee: ttraenkler/sendev-funcidx
priority: high
feasibility: hard
reasoning_effort: max
task_type: bugfix
area: codegen, ir
language_feature: tail-calls
goal: core-semantics
related: [602, 822, 839, 1972]
origin: "2026-06-21 sprint-64 — flagged as the '#54 IR tail-call regression'. No matching issue file existed; reproduced on upstream/main and filed as #2554."
---

# #2554 — IR path drops tail calls on top-level recursive functions

## Problem

A **top-level** self-recursive function in tail position overflows the Wasm
stack on deep recursion, while the **same function nested** inside another
function does not — at the same depth. Reproduced on upstream/main @ 1f88850ae
(host AND standalone):

```ts
function sum(n: number, acc: number): number {
  if (n === 0) return acc;
  return sum(n - 1, acc + n);   // tail-recursive
}
export function test(): number { return sum(1000000, 0); }   // RangeError: Maximum call stack size exceeded
```

```ts
export function test(): number {
  function sum(n: number, acc: number): number { if (n === 0) return acc; return sum(n - 1, acc + n); }
  return sum(1000000, 0);   // ✓ 500000500000 — nested form keeps the tail call
}
```

## Root cause

The legacy AST return path applies tail-call optimization in `maybeEmitTailCall`
(`src/codegen/statements/control-flow.ts`): a `return f(...)` whose trailing
instruction is a `call` / `call_ref` is rewritten to `return_call` /
`return_call_ref` (#602), replacing the caller frame so deep recursion does not
grow the stack.

The **IR lowering** (`src/ir/lower.ts`, the `return` terminator case) emits
`<operands…>; return` and **never** performs this conversion. So any function the
IR claims — notably **top-level** function declarations (the most IR-claimable
shape) — loses TCO. A nested function falls to the legacy path and keeps it,
hence the top-level-vs-nested split.

## Fix

A tail-call post-pass on the assembled IR body, applied in the integration layer
(`src/ir/integration.ts`) right before the lowered body is committed to
`ctx.mod.functions[localIdx]` — where the full module type info is available.
New `src/codegen/ir-tail-call.ts` (`applyIrTailCalls`) rewrites
`<call|call_ref>; return` → `return_call|return_call_ref` at any tail position
(top-level body and `if`/`block`/`loop` arms), enforcing the SAME guards as the
legacy path:

- callee param count == caller param count (#822);
- callee result type matches caller return type (ref/ref_null compatible) (#839);
- never inside a `try` (the pass does not descend into `try` bodies/handlers) so
  a callee throw cannot escape the enclosing catch (#1972).

## Acceptance criteria

- [x] Top-level `sum(1e6,0)` / `sum(2e6,0)` no longer overflow (host + standalone).
- [x] Mutual recursion (`isEven`/`isOdd`, both top-level) at 5e5 depth does not
      overflow.
- [x] A tail call inside `try { return f(); } catch` is still caught (NOT
      converted) — exception does not escape.
- [x] Return-type-mismatched / param-count-mismatched tail positions are left as
      `call` (no invalid Wasm).
- [x] `tests/issue-2554-ir-tail-call.test.ts`; typecheck + lint + format +
      stack-balance clean.
