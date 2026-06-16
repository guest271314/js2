---
id: 2079
title: "standalone: function* CEs with 'function index out of range' (late-import shift guard) — wasm-native generator lowering regressed; manual protocol leaks env import"
status: done
completed: 2026-06-15
sprint: 62
created: 2026-06-11
updated: 2026-06-15
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: generators
goal: host-independence
related: [2043, 2040]
origin: "2026-06-11 standalone spec audit (fable agent): verified on main @ 6bf881a0c, target standalone"
---

# #2079 — generators unusable in standalone mode

## Problem

```ts
function* g(){ yield 1; yield 2; return 3; }
for (const v of g()) s += v;
// standalone: COMPILE-ERROR "function index out of range — undefined …
//   late-import index-shift class" at function 'g'
// node: works
```

The manual `it.next()` protocol variant instead emits an env import and
fails zero-import instantiation.

## Root cause

The late-import shift guard (#2043, done — refusing loudly as designed)
fires on the standalone generator lowering: the generator path still adds
late imports after the freeze point. Residual of #1665 (done, wasm-native
generators) — the native lowering doesn't fully cover standalone, so it
falls into the guarded legacy path.

## Fix direction

Make the #1665 native generator lowering the standalone path end-to-end
(no late host imports); the guard then never fires. Coordinate with #2040
(standalone generator destructuring runtime semantics).

## Acceptance criteria

- Repro compiles and returns "12"-equivalent standalone, zero env imports
- Manual next() protocol works; host mode unchanged

## Dupe check

#1665 (done — regressed/residual standalone), #2043 (guard correct),
#2040 (destructuring semantics, different). Filed as the concrete
standalone-generator residual.

## Implementation (sdev1, 2026-06-15)

### Re-diagnosis — the simple funcindex CE was already fixed

On current main the original repro (`function* g(){ yield 1; yield 2; return 3; }`
+ for-of, and the manual `it.next()` protocol) compiles **standalone with zero
imports and runs correctly**. The late-import funcindex CE described in the
title no longer reproduces for sequential numeric yields — #1665's Phase-1
state machine handles them.

The ACTUAL residual blocking the ~960-test ROI is the **"sequential numeric
yields" hard CE** in `buildNativeGeneratorPlan`: it bailed (→ the scoped
`#680` compile diagnostic in standalone) on **any `while`/`for`/`do-while` loop
or `if`/`else` that contains a `yield`**. Loops/conditionals are the dominant
generator shape (`while(i<n){yield i; i++}`, `for(...)`), so this was the bulk
of the gap. This is exactly #680 "Phase 2" (architect estimate: "covers 85%").

### Fix — state-graph + trampoline (`src/codegen/generators-native.ts`)

Replaced the linear-segment plan with a **state-graph** plan. Each state has a
straight-line, yield-free prelude plus an explicit terminator:
`yield(next)` · `return(expr)` · `done` · `jump(next)` · `branch(cond, then,
else)`. Structured control flow lowers to states with explicit successor ids:

- `while`/`do-while`/`for` → a header state (`branch` on cond → body / exit)
  and a body whose tail `jump`s back to the header (the loop back-edge). The
  induction variable and all body-declared numeric locals **spill** to the
  state struct so they survive each suspension.
- `if`/`else` → a `branch` state into then/else entry states that `jump` to a
  shared join state.
- nested combinations recurse, producing more states.

The resume function (`__gen_resume_*`) is now a **trampoline**:
`block $exit { loop $dispatch { if(state==0){…} else if(state==1){…} … else
{done} } } local.get $__result`. A `yield`/`return` writes `$__result` and
`br`s out of the block (return to caller); a `jump`/`branch` sets the `state`
field and `br`s back to the dispatch `loop` to re-enter at the new state within
the **same** `next()` call. This models user loops as state self-transitions in
the trampoline (no wasm `loop` is emitted for the user loop), so each state body
stays straight-line and reuses `compileStatement`/`compileExpression` verbatim.

A `return` nested inside control flow (e.g. `if (i===3) return 99;`) is routed
through the structural lowering (not `compileStatement`) so it becomes a proper
`{value, done:true}` completion terminator instead of a raw wasm `return` (which
mis-coerced the value to the result-ref type → null deref).

### Late-import funcindex hardening (the #1899 class, real this time)

Phase-2 bodies compile arbitrary numeric expressions that **lazily register
helper functions** (`%` → f64-modulo, etc.) while the resume body is being
emitted. The old code computed `info.resumeFuncIdx = numImportFuncs +
functions.length` up front, then pushed the resume function **last** — so a
helper registered mid-body shifted the resume function past its captured index,
and every baked `call resumeFuncIdx` (the for-of driver, `.next()` dispatch) hit
the **helper** instead. Caught by the `if (i % 2 === 0) yield i` repro:
`call 52` resolved to the modulo helper ("not enough arguments on the stack").

Fix: **reserve the resume function's slot with a placeholder BEFORE emitting the
body** (same idiom as the accessor drivers in `accessor-driver.ts`), then fill
the placeholder in place. `funcIdx` stays stable while helpers append after it.
This also hardens the Phase-1 path against the same class.

### Scope kept conservative (clean bail, never wrong/invalid)

Unsupported shapes still return `null` → the scoped `#680` diagnostic (no
crash, no wrong answer, no invalid Wasm — verified): `yield*`, `for-of`/`for-in`
yielding, `break`/`continue` targeting a yield-loop, `switch`/labeled
statements with yields, `try/catch` with yields, and non-numeric yields/spills.
These are follow-ups under #2157.

### Validation

- `tests/issue-2079-standalone-generator-control-flow.test.ts` — 13 cases
  (while/for/do-while, if-else, nested loops, yields around loops, if-in-loop
  funcindex guard, return-in-loop, manual next(), `.next(value)` send,
  `.return()` early completion, infinite-generator partial consume, sequential
  regression). All pass, all zero-import standalone.
- No regression: `issue-680`, `issue-1665`, `issue-1665-standalone-generator-forof`,
  `generators`, async-iteration / async-function equivalence — all green.
  (`tests/*helpers.js`-importing suites fail to load on main too — untracked
  `tests/helpers.js`, pre-existing infra gotcha — and
  `arguments-nested-and-loops.test.ts:181` fails identically on unmodified main.)
- `tsc --noEmit` clean; `check:ir-fallbacks` OK (no unintended increases).
