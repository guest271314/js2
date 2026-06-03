---
id: 1261
title: "eval tiering: classify eval sites into 5 tiers at compile time"
status: done
created: 2026-05-02
updated: 2026-06-03
completed: 2026-06-03
priority: high
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen, type-analysis
language_feature: eval, strict-mode
goal: performance
sprint: Backlog
required_by: [1262, 1263, 1264, 1265]
---
# #1261 — eval tiering: classify eval sites into 5 tiers at compile time

## Problem

`eval` is currently treated as a single undifferentiated worst-case scenario. The actual impact on optimization ranges from zero (no eval in module) to severe (direct sloppy-mode eval). A tiered classification at compile time lets each tier apply exactly the right optimization overhead — nothing more.

## The 5 tiers

| Tier | Description | Optimization impact |
|------|-------------|---------------------|
| 1 | No eval anywhere in module | Full optimization, direct calls, unboxed locals |
| 2 | `eval("static string literal")` | Compile as regular code at compile time, zero runtime impact |
| 3 | Indirect eval `(0,eval)(...)` | Global scope only; locals unaffected; funcref indirection only for global fns in sloppy mode |
| 4 | Direct eval in strict mode | No function replacement; locals stay unboxed; shadow scope + null-check deopt (see #1264) |
| 5 | Direct eval in sloppy mode | Full boxing + mutable funcref globals for function replacement (see #1265) |

**Key insight**: TypeScript and ESM are always strict mode (tier 4 at worst). The worst case (tier 5) only applies to legacy sloppy-mode scripts — an increasingly rare target.

## Work

- Add `classifyEvalTier(sourceFile: ts.SourceFile): EvalTier` in `src/codegen/index.ts`
  - Scan for `eval(...)` call expressions
  - Detect strict mode: `"use strict"` directive, `.ts` extension, `.mjs`/ESM
  - Classify indirect vs direct eval via the callee shape
  - Classify string literal argument (tier 2)
- Expose `evalTier` on `ModuleContext` for downstream use by #1262–#1265
- Tier 1: already the default; make it explicit so we can assert no eval-related overhead fires

## Acceptance criteria

1. `classifyEvalTier` correctly returns tiers 1–5 for representative inputs (test in `tests/eval-tiering.test.ts`)
2. TypeScript source files always classify as tier ≤ 4 (strict mode assertion)
3. No behavior change — classification is read-only at this stage; actual optimization gating lands in follow-up issues

## Depends on

None — standalone analysis pass.

## Note on existing work

- **Tier 2 (static literal)** is already implemented via #1163 (done). #1261 should recognize it and skip any redundant handling.
- **Tier 3–5 scope boxing** is genuinely new — not covered by #1164 (runtime eval) or #1102/#1066 (standalone mode). Those address *how eval executes code*, not *how the surrounding scope is protected*.

## Unblocks

#1263, #1264, #1265, #1266

## Implementation (2026-06-03, dev-1387)

Landed the read-only classifier. No behaviour change — downstream gating
(#1262–#1265) consumes the result later.

- New module `src/codegen/eval-tiering.ts` exporting `enum EvalTier`
  (1=NoEval … 5=DirectSloppy) and `classifyEvalTier(sourceFile, checker)`.
  The classifier walks the source file, classifies each `eval` call site
  (reusing the `direct`/`indirect`/`none` callee-shape + `isGlobalEvalIdentifier`
  heuristics that mirror `expressions/calls.ts`), and returns the module-wide
  **maximum** (worst-case) tier. Short-circuits once tier 5 is reached.
  - Tier 2 (static literal) is detected by reusing `resolveConstantString`
    from `expressions/eval-inline.ts` (#1163's inliner) on the first argument
    — applies to both direct and indirect eval.
  - Strict-mode detection: a module (`externalModuleIndicator`/ESM
    `impliedNodeFormat`), a `.ts`/`.tsx`/`.mts`/`.mjs` file, or a script with a
    `"use strict"` prologue → strict (tier ≤ 4); a bare sloppy `.js` script with
    a dynamic direct eval → tier 5. Satisfies AC#2 (TS sources always tier ≤ 4).
  - Locally-shadowed `eval` (a param/var named `eval`) classifies as `none`.
- Exposed optional `evalTier?: EvalTier` on `CodegenContext`
  (`src/codegen/context/types.ts`) for #1262–#1265 to consume. Optional because
  not every context constructs from a full source file.

**Tests:** `tests/eval-tiering.test.ts` — 12 cases covering all 5 tiers, the
static-literal refinement (direct + indirect), the strict-mode invariant
(AC#2), `"use strict"` promotion, module worst-case aggregation, and the
local-shadow case. (Validated locally via a standalone tsx harness;
`vitest` could not run in-container due to a full `/workspace` disk —
CI runs the suite with adequate disk.)

Read-only at this stage; AC#3 (no behaviour change) holds — nothing consumes
`evalTier` yet.
