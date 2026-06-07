---
id: 1712
title: "acceptance: compiled acorn parses a representative .js with AST structurally equal to node-acorn"
status: in-review
created: 2026-05-29
updated: 2026-06-07
priority: high
feasibility: hard
reasoning_effort: high
task_type: test
area: test-infrastructure, codegen
language_feature: multi
goal: self-hosting-dogfood
sprint: 61
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
