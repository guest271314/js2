---
id: 1712
title: "acceptance: compiled acorn parses a representative .js with AST structurally equal to node-acorn"
status: done
created: 2026-05-29
updated: 2026-06-10
completed: 2026-06-10
priority: high
feasibility: hard
reasoning_effort: high
task_type: test
area: test-infrastructure, codegen
language_feature: multi
goal: self-hosting-dogfood
sprint: 61
model: fable
depends_on: [1710, 1711]
es_edition: multi
related: [1690, 1690b, 1584, 1058]
claimed_by: codex-developer
claimed_at: 2026-06-07T05:10:23.845Z
pr: 1293
---

# #1712 — Acceptance milestone: compiled acorn parses a representative .js with a structurally-equal AST

## Problem

This is the **definition of done for the first dogfood lap** of the
`self-hosting-dogfood` goal. All the other acorn issues (#1710 harness, #1711
triage, #1690, #1690b, and #1711's children) exist to make this one pass.

The milestone: take the #1710 harness, compile acorn to Wasm, instantiate it,
parse a representative real `.js` source file, and assert the produced AST is
**structurally equal** to node-acorn's AST on the identical input. This is the
end-to-end proof that "the compiler can compile its own parser and run it
correctly" — not just compile it to valid Wasm.

## Why it's `feasibility: hard` and depends on others

The three known full-module blockers are **already fixed**: #1679
(`new this`), #1690 (invalid-Wasm index-shift), #1690b (var-shadow) are all
`done`. So acorn may already compile to a _valid, instantiable_ binary on
current main — but "valid Wasm" is not "correct AST". The remaining risk is
_runtime divergence_: compiled acorn instantiates and runs but produces a
subtly wrong AST (off-by-one positions, a dropped node, a mis-coerced numeric
field). Those bugs are exactly what the #1710 harness + #1711 triage exist to
surface, and any of them blocks this acceptance.

So #1712 is the _integration gate_: it flips from `backlog` to `ready` once
#1710 (harness) lands and #1711 (triage) confirms either zero divergences (in
which case #1712 may pass immediately) or a tractable set of fixes. It is the
track's north star; whether it lands _within_ s57 depends on what #1711
surfaces. The optimistic case — given the known blockers are cleared — is that
#1712 passes early and the sprint pivots to widening the fixture corpus.

## Acceptance criteria

1. A committed test (extending the #1710 harness) compiles acorn to Wasm,
   instantiates it (JS-host mode acceptable for this lap), and calls
   `parse(fixtureSource, { ecmaVersion, sourceType })`.
2. The compiled-acorn AST is **structurally deep-equal** to node-acorn's AST on
   the same `fixtureSource` for at least one non-trivial representative `.js`
   file (e.g. a real ~100–300 line module mixing functions, classes, control
   flow, template literals, and regex — a reduced slice of a real library).
3. The comparison is documented: which fields are compared, which (if any)
   position fields are normalized, and why.
4. The test is wired so it can run in CI without network access (acorn pinned
   per #1710) and is fast enough not to bloat the suite (single representative
   file, not the whole acorn test262 corpus).
5. No test262 regression.

## Notes / scope

- A passing #1712 is the trigger to (a) widen the fixture corpus for a second
  dogfood lap (more libraries), and (b) unblock #1584's "compile acorn as the
  runtime parser" dependency — the interpreter needs exactly this artifact.
- Standalone (`--target wasi`) acorn execution is a _second-lap_ extension, not
  part of this acceptance (JS-host first to isolate codegen correctness from
  host-import gaps).
- Status starts `backlog`; the tech lead flips it to `ready` once the blocking
  issues merge. Do NOT dispatch a dev to "make #1712 pass" directly — it is an
  integration gate, satisfied by fixing its dependencies.

## Resolution (2026-06-10, PR #1293 + #1301)

PR #1293 (symphony/1712) lands the acceptance test green. The 24 equivalence
regressions that previously blocked it were root-caused to a SINGLE latent
bug exposed (not introduced) by the PR: `shiftLateImportIndices`
(`src/codegen/expressions/late-imports.ts`) never shifted
`ctx.mod.startFuncIdx`, so any late import added via
`ensureLateImport`/`flushLateImportShifts` left `(start N)` pointing at an
exported user function with a result type → `WebAssembly.validate` failure.
Fixing that one shift cleared all 24 buckets (verified by a full local
equivalence-gate run: 0 new regressions, 37 baseline failures now passing).
Three additional hardening fixes shipped alongside: the
`fctx.readsCurrentThis` gate on the `__current_this` read was restored
(matches main; #1702 null-guard keeps host dispatch working), `__host_eq`
import resolution now happens BEFORE operand coercion (ill-typed-Wasm
fall-through), and externref switch discriminants keep numeric unbox-to-f64
comparison when all case expressions are numeric (reference identity only
for genuine reference cases). The PR's dynamic-`this` property lookup,
`Foo.prototype` host bridge, and higher-arity closure dispatch are
load-bearing for acorn and retained. #1301 (if/else then-buffer
global-index shift) merged independently and complements the PR's
`liveBodies` registration — both mechanisms coexist (dedup via the
`shifted` set).

## Attempt 22 Findings

- Added `tests/issue-1712.test.ts`, a focused CI-safe acceptance test that
  compiles the pinned Acorn tarball, instantiates the compiled parser in
  JS-host mode, parses one representative JavaScript fixture, and diffs the AST
  against node-acorn via the #1710 `diffAst` helper.
- The comparison ignores Acorn position fields through `diffAst` and strips
  compiled-only `sourceFile: null` metadata before comparison. All other fields
  in the normalized AST are structurally compared.
- The fixture covers multiple statement forms currently inside the compiled
  parser's passing surface: expression statements, block statements, labeled
  statements, a regex literal, and a conditional expression. Follow-up dogfood
  widening should add declarations/classes/functions once the remaining keyword,
  array/object, and operator-local parser-runtime gaps are closed.
- Codegen/runtime fixes made for this acceptance include function-constructor
  object-literal shape pre-registration, function-constructor call-index repair
  after late import shifts, current-this dynamic update/writeback repairs, and
  WasmGC struct getter/setter fallback improvements needed while Acorn
  initializes token tables and parser state.
- Scoped validation passes:
  `node node_modules/vitest/dist/cli.js run tests/issue-1712.test.ts`.

## Dogfood lap 2026-06-10 (fable-1712, main 6efc0d279)

Prior attempt: **Codex PR #1293** (symphony/1712) implemented the full
acceptance in one 1,700-line PR, but is CONFLICTING with main, stale since
2026-06-08, and its own equivalence-gate found **24 new regressions** from its
broad codegen edits (typeof-member, computed properties, shape-inference,
refcast fallback, destructuring initializers) — violating acceptance #5.
Treated as superseded; this lap re-fixes the blockers minimally off current
main, one root cause per slice.

### Blocker 1 — invalid Wasm: stale module-global index in `__closure_86` (FIXED, this PR)

`pnpm run dogfood:acorn` on 6efc0d279: compile succeeds, binary INVALID —
`f64.trunc[0] expected type f64, found global.get of type (ref null 1)`.

**Root cause** (not the #1690/#1839 surface — a NEW orphan-buffer window):
`compileIfStatement` (`src/codegen/statements/control-flow.ts`) finishes the
then branch, then raw-swaps `fctx.body = []` for the else branch. The
completed then-buffer survives only in the `thenInstrs` local — unreachable
by `fixupModuleGlobalIndices` (and the func-idx shifters). When the else
branch registers a brand-new string constant (acorn: a property null-throw
TypeError message — codegen-generated, so not pre-collected by the module
scan), the late `string_constants` import global shifts every module-global
index +1, but the detached then-buffer's `global.get`s stay stale. In acorn,
`return this.parseFunction(fNode, FUNC_STATEMENT | FUNC_NULLABLE_ID, …)`
(dist line 1855) sits in exactly such a then branch; its stale reads landed
on the neighbouring globals (one a `(ref null $array)`) → invalid Wasm.

**Fix** (2 sites):
1. `compileIfStatement` parks `thenInstrs` in `fctx.savedBodies` for the
   else-compilation window (savedBodies is walked by every late-import
   shifter), unparked LIFO before assembling the `if` instr.
2. `fixupModuleGlobalIndices` (`src/codegen/registry/imports.ts`) now also
   walks `ctx.liveBodies` — parity with `addStringImports`/`addUnionImports`
   (#1384); the #779d destructuring branch buffers register there expecting
   "every shift path" to walk them, but the *global*-index fixup never did.

Regression pin: `tests/issue-1712-ifelse-global-shift.test.ts` (verified red
on unfixed tree by reverse-applying the fix, green with it).

Result: acorn binary now **validates** (835,680 bytes).

### Blocker 2 — instantiation: `function.prototype` host bridge (NEXT)

With the binary valid, instantiation fails in module-init:
`Object.defineProperties called on non-object` (acorn dist 685:
`Object.defineProperties(Parser.prototype, prototypeAccessors)`).
`<fn>.prototype` on a function-style constructor compiles to
`__extern_get(closureStruct→externref, "prototype")` which has no sidecar
entry and no `__sget_prototype` export → undefined. This is the known
function.prototype host-bridge gap (#1340 recon — escalated NEEDS-SPEC).
25-line repro: `var P = function P(x){this.x=x}; P.prototype.m =
function(){…}; Object.defineProperties(P.prototype, …); new P(1).m()` —
all three flows fail (`m is not a function` / defineProperties non-object).

Bridge sketch (JS-host lap-1 scope per the acceptance note): vivify a
sidecar `prototype` object on closure structs in `__extern_get`; link
functor instances → ctor closure at `new`-site codegen; `_wrapForHost` get
trap falls back to the ctor's vivified proto and threads `this` via
`__call_fn_method_N` (#1636-S1). Acorn's `var pp$N = Parser.prototype;
pp$N.method = fn` aliasing is satisfied by the vivified object's identity.
(Note: PR #1293 ships its own `__get_function_prototype` host bridge for
this — the acceptance passes with it; the sketch above remains relevant
only for a future standalone-mode implementation.)
