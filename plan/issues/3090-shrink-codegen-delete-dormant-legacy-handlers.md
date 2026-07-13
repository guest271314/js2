---
id: 3090
title: "Shrink codegen: delete dormant legacy direct-codegen handlers superseded by IR (~40–55K net LOC)"
status: ready
# Phase 0 (audit) landed 2026-07-10 by ttraenkler/fable-6th — see
# "## Phase 0 audit landed" below. Umbrella stays open: next claimable slice
# is Phase 2 (knip + unreferenced deletions, ~2.1K); handler deletions are
# GATED (see the audit doc's G1–G4) — do not start Phase 1 before the gates.
sprint: current
created: 2026-07-08
updated: 2026-07-13
priority: high
horizon: xl
feasibility: medium
reasoning_effort: medium
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: ir-full-coverage
related: [2855, 2856]
---

# #3090 — Shrink codegen: delete the dormant legacy direct-codegen handlers the IR already supersedes

## Why (motivation)

The compiler ships **two front-ends at once**: the legacy direct AST→Wasm
path (`src/codegen/`, accumulated hacks) and the typed IR
(`src/ir/`, `from-ast.ts` → `lower.ts` → `backend/`). With
`experimentalIR: true` the default (`src/codegen/index.ts:1540`), the IR
body is the one that **ships** for every `ir-owned` kind — yet the legacy
direct handler for those kinds is still compiled in as dormant fallback.
That duplication is the single biggest reason the compiler is ~6.4× the
size of a comparable linear-memory TS→Wasm compiler (Porffor: ~32K code
vs our ~207K).

`#2855` (+ `#2856`–`#2859`) drives the _fallback buckets_ to zero and
promotes reasons into `STRICT_IR_REASONS` — but it **does not delete** the
now-dead legacy bodies. This issue is the complementary **subtraction**
pass: actually remove the dormant code so the tree shrinks.

## Measured opportunity (tokei, 2026-07-08 baseline)

`src/codegen/` = **154,938** code lines / 150 files. Three-way split:

| Bucket                                                                                                                                                                                                                                                                       |    Code | Disposition   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------: | ------------- |
| **STAYS** — substrate/orchestrator the IR reuses (`index.ts`, `coercion-engine`, `js-tag`, `value-tags`, `native-strings`, `registry/`, `context/`, `regex/`, `statements/{loops,control-flow}`…)                                                                            | ~35,221 | keep          |
| **RUNTIME** — stdlib _behavior_ emission (`object-runtime`, `array-methods`, `property-access`, `native-regex`, `map-runtime`, `dataview`, generators…) — the IR backend calls it; a front-end swap does not remove the need to emit an array `.map` loop or a regex matcher | ~39,635 | **keep**      |
| **FRONTEND** — AST→Wasm dispatch & lowering that `from-ast.ts`/`lower.ts` replace (`expressions/`, operator/closure/literal/object lowering, statement lowering…)                                                                                                            | ~80,082 | **deletable** |

**Net estimate: ~40–55K code lines removed** after (a) subtracting ~8–10K
of FRONTEND-classified files that are really shared emission passes
(`stack-balance.ts`, `type-coercion.ts`, `regexp-standalone.ts`), and
(b) offsetting ~15–25K of IR growth needed to finish the remaining
`mixed`/`direct-only` kinds. That takes `src/` from ~207K → **~155–165K
code (~20–27% smaller compiler)** with **no capability change** for the
Phase‑1 slice. It does _not_ close the gap to Porffor — RUNTIME (~40K) and
WasmGC substrate (~35K) are intrinsic to targeting WasmGC with a full
stdlib.

## Scope — what to delete vs never touch

**Delete (only):** legacy direct-codegen handlers for AST kinds that are
already `ir-owned` in `plan/log/ir-adoption.md` (22 kinds today), i.e. the
FRONTEND-bucket lowering that is unreachable when `experimentalIR: true`.

**Never touch:**

- Any file in **STAYS** or **RUNTIME** (substrate + stdlib behavior).
- **Deferred** kinds (`eval`, `with`, `Proxy`, `for-in`, async-generator…) —
  they remain direct-only by design; their handlers (e.g. `with-scope.ts`)
  stay.
- Any handler for a `mixed`/`direct-only` kind — the legacy path is still
  live for those until `#2855`-family work flips them to `ir-owned`
  (Phase 3 couples deletion to that flip, per-PR).

## Plan (Fable-friendly: mechanical, sliceable, test-gated)

**Phase 0 — audit → ranked delete-list (1 slice, `s`/`m`).**
Per-function attribution over the 89 FRONTEND files: mark each exported
function legacy-only vs shared, by call-graph reachability from the
non-IR branch in `src/codegen/index.ts` (the demote-to-warning fallback
~`index.ts:889`). Output a checklist doc under `plan/log/` mapping
{kind → file → deletable functions → LOC}, cross-checked against the
`ir-owned` rows of `plan/log/ir-adoption.md`. Replaces the ±10K estimate
band with a hard number and becomes the work-list for Phases 1–2.

**Phase 1 — delete dormant `ir-owned` legacy handlers (many `s`/`m` slices).**
One slice per kind (or per FRONTEND file). Delete the dead handler + its
now-unreferenced local helpers; keep the dispatch shim only if a
`mixed`/deferred kind still needs it. **Zero capability change** — proven by
green full CI + equivalence tests + **no test262 regression** (broad-impact
change ⇒ validate on full CI / `merge_group`, never a scoped sweep;
standalone-floor only runs on `merge_group`). Highest-confidence subtraction;
do first.

**Phase 2 — dead-code sweep (1 slice, `s`).**
No `knip`/`ts-prune` is configured today. Add `knip` to the `quality` CI
job and delete the orphaned exports it flags across `src/codegen/`
(handlers stranded by refactors, helpers no longer dispatched). Low-risk
mechanical win; catches residue Phase 1 leaves behind.

**Phase 3 — couple deletion to bucket-flips (ongoing, follows `#2855`).**
As each `mixed`/`direct-only` kind flips to `ir-owned` (via `#2856`-family
work), **delete its legacy handler in the same PR** rather than leaving it
dormant. Add a "legacy LOC deleted" metric alongside the `#2855` ratchet so
retirement is tracked as subtraction, not just bucket-zeroing.

## Phase 0 audit landed (2026-07-10)

Deliverables: `scripts/audit-legacy-reachability.mjs` (call-graph
reachability, re-runnable, `--why` path tracing) +
`plan/log/3090-phase0-legacy-delete-list.md` (ranked delete-list, hard
numbers, kind→file mapping).

**Hard numbers:** FRONTEND legacy-only = **59,976 fn-lines** across 35 files
(ranked list in the doc); deletable-NOW (unreferenced) ≈ **2.1K fn-lines**
(index.ts `collect*Imports` family ~1.4K, regex/vm.ts 245, strays).

**Premise correction — handler deletion is GATED, not free:** (G1) the
default pipeline legacy-compiles EVERY function and the IR merely overlays
bodies (IR-first #2138 is flag-gated, not default); (G2) the whole-function
claim unit means any rejected function needs the legacy handler for every
kind it contains — `ir-owned` status does NOT make a handler dead; (G3)
top-level statements always compile via legacy; (G4) ~47K fn-lines of
RUNTIME stdlib emission are reachable ONLY via legacy dispatch — the IR
needs its own entry points before front-end retirement. Revised phase order
in the audit doc: Phase 2 (knip + unreferenced) first; handler deletions
couple to gate-clearing slices (IR-first default, module-level adoption,
per-kind bucket closure, IR→runtime entry points).

## Acceptance criteria

- [x] Phase 0 audit doc committed with a hard deletable-LOC number + ranked
      per-file/per-kind delete-list. (2026-07-10,
      `plan/log/3090-phase0-legacy-delete-list.md`)
- [ ] `src/codegen/` shrinks by **≥ 30K code lines** net across Phases 1–2
      (stretch: ≥ 45K), measured by `tokei src` before/after (baseline
      `src` = 206,674 code; `src/codegen` = 154,938).
- [ ] **Zero test262 regressions** vs baseline on `merge_group` for every
      slice; equivalence suite green.
- [ ] No file in the STAYS/RUNTIME buckets or any deferred-kind handler is
      modified by Phase 1.
- [x] Dead-export gate wired into the `quality` CI job (Phase 2); no new
      orphaned exports. (2026-07-10 — implemented **dep-free** via the Phase 0
      audit tool instead of `knip`: `pnpm run check:dead-exports` ratchets the
      unreferenced set against `scripts/dead-export-baseline.json`, same
      baseline/--update convention as the other quality ratchets. `knip` can
      still be added later if repo-wide unused-dependency coverage is wanted;
      for the #3090 enforcement goal the audit tool is a superset for
      src/codegen and adds no dependency. Phase 2a PR #2856 deleted the dead
      `collect*Imports` family (-1,474); Phase 2b PR #2858 the remaining
      strays (-332).)

## Phase 2d — fresh audit re-run + confirmed-dead deletions (2026-07-11)

Fresh `audit-legacy-reachability.mjs` run @ `026f40f771` (main advanced ~25
PRs since Phase 0): FRONTEND legacy-only grew 59,976 → **61,118** fn-lines
(calls.ts 16.2K → 16.9K — the legacy front-end is still growing; motivates
Phase-3 coupling). Remaining unreferenced set: **470 fn-lines** across all
buckets, of which `regex/vm.ts` (245) is a deliberate keep (executable
reference spec — `native-regex.ts` imports `REGEX_STEP_CAP`; `search` is the
oracle in `tests/regex-bytecode.test.ts` / `tests/issue-2091-*`), and 9 more
functions are test-imported (audit's known tests-blind-spot:
`value-tags` trio, `getBuiltinParent`, `withSpeculativeCompile`,
`fallback-telemetry` pair, `quickJsLibRegexpEngineConfig`, index.ts
`getPseudoExternClassInfo`/`resolveMethodDispatchTarget`).

Deleted the confirmed-dead residue (-198 lines): `expressions.ts` superseded
`emitCoercedLocalSet`/`updateLocalType`/`widenLocalToNullable` trio (live
copies live in `expressions/helpers.ts`), `index.ts#registerExternClassImports`,
`type-coercion.ts#emitSafeExternrefToF64`, `registry/types.ts#valTypeEq`
(`emit/binary.ts` has its own local copy), `async-cps.ts` PR1 stubs
(`compileNestedAwait`/`emitAsyncStateMachineFromIr`), `timsort.ts#LT`.
Dead-export baseline ratcheted 36 → 16 entries (19 stale entries from
already-landed deletions also cleared). Byte-inertness proven: 13 playground
examples × 2 string modes SHA-identical vs base commit.

## Phase 2e — dead `UndefinedKeyword`-as-expression handler + disjuncts (2026-07-13, opus-dead)

A **structurally-dead** (not merely unreferenced) deletion the static
reachability audit cannot see, found via the byte-identity oracle.

**Root cause / WHY it is dead:** in TypeScript's parsed AST the value
`undefined` is always an `Identifier` (text `"undefined"`); the
`UndefinedKeyword` SyntaxKind is emitted **only in type position**
(`x: undefined`), never as an `ts.Expression`. Verified with an AST probe
over every value/type occurrence (0 expression-position `UndefinedKeyword`,
type-position only) and a repo-wide scan confirming nothing synthesizes an
`UndefinedKeyword` **expression** node and feeds it to the dispatcher. So the
`compileExpressionInner` dispatch arm `if (expr.kind === UndefinedKeyword)`
was a dead handler branch, and the three `inner.kind === UndefinedKeyword ||`
disjuncts in the numeric / ref / any-value null-fast-paths were always-false
`||` operands (the companion `ts.isIdentifier(inner) && inner.text ===
"undefined"` clause is the live one and is retained).

Note this is why the audit's static reachability marked these regions "live":
the enclosing functions ARE reached; only the specific `UndefinedKeyword`
sub-conditions are unreachable — a case only the emit-byte oracle catches.

**Deleted** (all in `src/codegen/expressions.ts`, my lane): the dead dispatch
arm in `compileExpressionInner` + the 3 dead disjuncts in
`compileExpressionBody`. **Net −14 LOC** (3 ins / 17 del); `emitUndefined`
retains 8 live callers (no orphaned symbol).

**Byte-identity PROOF of dead-ness:** `prove-emit-identity check` over the full
`website/playground/examples/` corpus × {gc, standalone, wasi} = **39/39
(file,target) emits IDENTICAL** to the pre-edit golden baseline. Behaviour
cross-check: the null/undefined equivalence batch (11 files, 83 cases)
produces the **same 8 pre-existing failures** (`null-dereference-guards`
#396) with and without the change — **zero delta**. typecheck / prettier /
`check:dead-exports` / `check:ir-fallbacks` / `check:loc-budget` all green.

## Guardrails / hazards

- **Broad impact** — each deletion slice touches the shipping compiler;
  validate on full CI / `merge_group`, not a scoped issue sweep
  (see memory `project_broad_impact_validate_full_ci`,
  `project_standalone_floor_only_on_merge_group`).
- **Don't confuse RUNTIME with FRONTEND** — `array-methods`/`object-runtime`/
  `native-regex` have zero IR imports today but emit behavior both paths
  need; deleting them breaks features. Only delete what Phase 0 proves is
  reachable _solely_ via the legacy front-end dispatch.
- **Late-import funcidx discipline** — codegen is sensitive to function-index
  shifts; deleting a handler that registered helper imports can shift
  indices. Re-run the standalone floor on `merge_group` for any slice that
  removes an import-registering helper.
- One slice = one kind/file = one PR; keep slices small so a regression
  bisects to a single deletion.

## Notes

Suited to a Fable dev fleet: Phase 1/2 are high-confidence, mechanical,
per-slice deletions gated by strong existing test coverage — parallelizable
across several devs with low collision risk (distinct files per slice).
Phase 0 (the audit) is a good first single-owner task; consider a fan-out
over the 89 FRONTEND files to produce the delete-list quickly.
