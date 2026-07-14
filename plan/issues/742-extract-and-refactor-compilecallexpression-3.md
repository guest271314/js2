---
id: 742
title: "Extract and refactor compileCallExpression (3,350 lines)"
status: in-progress
assignee: ttraenkler/sendev-waveb
created: 2026-03-17
updated: 2026-07-14
priority: high
# (#742 Wave B, PR by sendev-waveb) The identifier-callee dispatch arm was moved
# verbatim into the new sibling module call-identifier.ts. Two change-scoped
# gates flag the NEW file (both net-zero across the tree — a pure relocation):
#   - loc-budget: call-identifier.ts is a new 2.1k-LOC module (> 1500 threshold).
#   - coercion-sites: the 7 coercion-vocabulary sites moved out of calls.ts into
#     it (calls.ts loses exactly these; net-zero). Not new hand-rolled coercion.
loc-budget-allow:
  - src/codegen/expressions/call-identifier.ts
coercion-sites-allow:
  - src/codegen/expressions/call-identifier.ts
# 2026-07-12 (#3182 groom): elevated medium→high. The EXTRACTION half is done
# (calls.ts exists, 18,753 LOC — see #803, closed as landed); the live scope is
# the REFACTOR half: break up compileCallExpression inside
# src/codegen/expressions/calls.ts and table-drive the dispatch chain.
feasibility: medium
goal: maintainability
sprint: current
depends_on: [688]
files:
  src/codegen/expressions.ts:
    breaking:
      - "extract compileCallExpression (3,350 lines) into calls.ts"
      - "convert dispatch to table-driven pattern"
---
# #742 — Extract and refactor compileCallExpression (3,350 lines)

## Status: open

## Problem

`compileCallExpression` is 3,350 lines — the largest single function in the codebase. It's a massive if/else chain dispatching on callee type, method name, and receiver type. Previous extraction attempt (#688 step 9) was reverted due to a bug.

## Approach

1. Extract into `src/codegen/calls.ts` (retry of #688 step 9)
2. Must work on the current expressions.ts (14,314 lines) which already has 8 extractions
3. Careful dependency analysis — many functions were moved to other modules
4. Convert the dispatch chain to a table: `Map<string, CompileHandler>`

## What to extract
- `compileCallExpression` (3,350 lines)
- `compileNewExpression` (777 lines)
- `compileClosureCall`, `compileCallablePropertyCall`
- `compileSuperMethodCall`, `compileSuperElementMethodCall`
- `compileExternMethodCall`
- `compileOptionalCallExpression`, `compileOptionalDirectCall`
- Builtins: `compileMathCall` (355), `compileDateMethodCall` (267), `compileConsoleCall`, `compileConsoleCallWasi`
- IIFE handling, spread args

## Previous attempt failure
The agent branched before other extractions, so imports pointed to wrong modules. Must branch from current main.

## Complexity: L

## Unblocked + re-scope note (2026-06-12)

Blocker #688 is long done — flipped to `ready`. Content is stale on every fact (compileCallExpression is now ~9,082 lines, was 3,350; the expressions/ split happened). Re-scope before dispatch: (a) table-driven callee dispatch registry, (b) builtin lowerings migrate into #2088's per-builtin scaffold. Bug density in calls.ts is LOW (0.9/KLOC) — this is maintainability work, not a correctness lever.

## Progress — incremental step 1 (2026-06-17, PR by cs-1931)

Started the decomposition with the **self-contained early-guard prelude** of
`compileCallExpression`, the lowest-risk slice (the prior attempt was reverted
for doing too much at once / branching wrong, so this proceeds incrementally
off current `origin/main`).

Extracted into a new `src/codegen/expressions/calls-guards.ts`, each as a
`(ctx, fctx, expr) => InnerResult | undefined` handler (undefined = not-my-case,
caller continues dispatch):

- `tryNamespaceNonCallable` — `Math()/JSON()/Reflect()/Atomics()/Proxy()` as a
  function throw TypeError (#1732/#2180).
- `tryJsxRuntimeCall` — `_jsx/_jsxs/_jsxDEV` runtime intercept (#1540).
- `tryRegExpConstructorCall` — `RegExp(p, f)` without `new`.
- `tryObjectCoercionCall` — `Object(x)` ToObject coercion (#1129/#1568).

`compileCallExpression`: 9,437 → 9,242 lines. **Behaviour-preserving** — a
WAT-hash oracle over 25 call-heavy programs is byte-identical before/after.
Tests: `tests/issue-742.test.ts` (wasm≡JS for the extracted guards).

**Remaining** (future PRs, same incremental pattern + WAT oracle): continue
pulling self-contained guard/dispatch blocks out of the prelude; then tackle the
method-dispatch core; finally the table-driven callee registry (re-scope item a).
Builtin lowerings stay deferred to #2088's per-builtin scaffold (re-scope item b).
Issue stays `in-progress`.

## Progress — Wave B chunk 1: identifier-callee dispatch (2026-07-14, sendev-waveb)

By this point `compileCallExpression` had grown to **~13,371 lines** (5136–18506
in `calls.ts`) — the single biggest function in the codebase. Its body is a flat
sequence of dispatch arms guarded on the *shape* of `expr.expression`
(property-access → method call; identifier → global/direct call; super; element
access; conditional; …). Crucially, the only function-scope locals live in the
**prelude** (`nodeProcessCall`, `_aggCallee`, …) and are consumed immediately —
**no dispatch arm closes over prelude state**, so each arm depends only on
`ctx` / `fctx` / `expr` and is cleanly liftable.

This chunk extracts the **identifier-callee dispatch family** — the block that
handles a bare-identifier callee: node:fs global functions
(`readFileSync`/`writeFileSync`, WASI + JS-host lowerings), the inline global
builtins (`parseInt`/`parseFloat`/`isNaN`/`isFinite`/`Array(...)`), and direct
named-function calls resolved through `funcMap`. That was lines 14714–16717
(~2,004 LOC), a contiguous run of five `if`-guarded arms.

Done in two verified steps (safety-first, byte-identity gated at each step):

1. **Same-file extraction** → a top-level `compileIdentifierCall(ctx, fctx,
   expr): InnerResult | undefined`. Verbatim move; the block's implicit
   fall-through (reaching the arm's end without returning) becomes
   `return undefined`, and the call site does
   `const r = compileIdentifierCall(...); if (r !== undefined) return r;`.
   `undefined` is a safe fall-through sentinel because `InnerResult` never
   includes it (no `return undefined` / bare `return;` in the moved span).
2. **Relocate to sibling module** `src/codegen/expressions/call-identifier.ts`.
   The 14 `calls.ts`-internal symbols the arm needs are exported from `calls.ts`
   (`emitBoundFunctionCall`, `tryEmitInlineDynamicCall`, the `calleeIsX`
   predicates, `PATH_BASED_FS_FNS`, …); `calls.ts` imports `compileIdentifierCall`
   back. The resulting `calls.ts ↔ call-identifier.ts` cycle is lazy
   (used only inside function bodies) and matches the existing
   `calls.ts ↔ calls-closures.ts` / `new-super.ts` cycles.

**Result**: `compileCallExpression` ~13,371 → ~11,388 LOC; `calls.ts` 19,435 →
17,441 LOC; new `call-identifier.ts` 2,105 LOC.

**Byte-identity proof**: `scripts/prove-emit-identity.mjs` — IDENTICAL across all
39 `(file,target)` emits (gc/standalone/wasi × the 13-file playground corpus)
after each step. `tsc --noEmit` 0 errors. `check:oracle-ratchet` net-zero
(`getTypeAtLocation +0`, `ctx.checker +0`). Smoke test:
`tests/issue-742.test.ts` adds wasm≡JS cases for the moved paths (parseInt
family, `Array(...)`, direct/recursive named calls).

The two `*-allow` frontmatter keys sanction the *new file* the two change-scoped
gates flag — both net-zero across the tree (a pure relocation), not new code.

**Next chunks (Wave B, serial)**: the 9k-line property-access method-call arm
(5632–14712) is the remaining giant — decompose it into per-receiver-family
helpers; then the super / element-access / conditional / IIFE arms. Issue stays
`in-progress`.
