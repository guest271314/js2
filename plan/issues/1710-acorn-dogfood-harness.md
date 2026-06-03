---
id: 1710
title: "acorn dogfood harness: compile + validate + differential-AST vs node-acorn"
status: done
created: 2026-05-29
updated: 2026-06-02
completed: 2026-05-29
priority: high
feasibility: medium
reasoning_effort: medium
task_type: test
area: tooling, test-infrastructure
language_feature: n/a
goal: self-hosting-dogfood
sprint: 58
required_by: [1711, 1712]
es_edition: multi
related: [1679, 1690, 1690b, 1584, 1058]
---
# #1710 — acorn dogfood harness: compile + validate + differential-AST vs node-acorn

## Problem

acorn has already surfaced three real compiler defects (#1679 `new this`,
#1690 invalid-Wasm index-shift, #1690b var-shadow), but every investigation so
far has used throwaway scratch files under `.tmp/acorn/` (`probe.mjs`,
`repro*.mjs`). There is **no committed, reproducible harness** that any agent
can run to regenerate the acorn failure surface, and no automated oracle for
*runtime* correctness — the scratch probes only check `WebAssembly.compile()`
validation, not whether compiled acorn produces the *right AST*.

Without a harness, the dogfood loop is not repeatable: each agent re-derives
the repro, the failure surface is never captured as data, and there is no
regression guard once a gap is fixed.

## Goal

Build a committed harness that mechanizes the dogfood loop:

1. **Acquire acorn deterministically** — **DECISION (2026-05-29, project lead):
   use a pinned `npm pack` step** at harness setup (acorn 8.16.0, matching
   #1690), not a vendored source copy. Pin the exact version + integrity so the
   harness is reproducible; resolve the packed tarball into the harness's
   fixture dir at setup time. Do NOT depend on an unpinned live network fetch at
   test time (CI may have no network mid-run — fetch happens at setup/install).
2. **Compile** each acorn entry module (`acorn.mjs`) via the programmatic
   `compile(src, { fileName: "acorn.mjs" })` API and record:
   - compile `success` + the categorized error list (collapse the known TS
     `Property does not exist` JS-noise warnings into one bucket — they are not
     blockers, per #1679/#1690).
   - `WebAssembly.compile(binary)` validation result + the first validator
     error verbatim (the surface that exposed #1690).
3. **Run + differentially test** — when the binary validates, instantiate it
   (JS-host mode is acceptable for the first lap; standalone is a follow-up),
   call acorn's `parse(source, options)` on a small fixture corpus of `.js`
   inputs, and structurally compare the resulting AST to **node-acorn**'s AST
   on the identical input. Report the first divergence (path + expected vs
   actual node).
4. **Emit a structured surface report** — write a machine-readable summary
   (JSON) of `{ compile_errors[], validation_error|null, ast_divergences[] }`
   so #1711 (triage) can bucket it mechanically. Print a human summary too.

## Fixture corpus

Start tiny and idiomatic — enough to exercise the parser's hot paths without
a huge oracle diff:

- `tests/fixtures/acorn-inputs/arith.js` — `const x = 1 + 2 * (3 - 4);`
- `tests/fixtures/acorn-inputs/fn.js` — a function decl + arrow + default param
- `tests/fixtures/acorn-inputs/class.js` — a small class with a method + getter
- `tests/fixtures/acorn-inputs/control.js` — `if`/`for`/`while`/`try` mix
- `tests/fixtures/acorn-inputs/strings.js` — template literal + regex literal

Each fixture is parsed by both compiled-acorn and node-acorn with the same
`ecmaVersion`/`sourceType` options; ASTs are compared with a structural deep
equal that ignores `start`/`end`/position fields if those prove noisy (note
the decision in the harness).

## Acceptance criteria

1. A committed harness (e.g. `tests/dogfood/acorn-harness.mjs` + a thin
   `tests/dogfood/acorn.test.ts` wrapper, OR a `scripts/dogfood-acorn.mjs`
   invoked by an npm script `pnpm run dogfood:acorn`) reproduces the current
   acorn failure surface deterministically from a clean checkout, with **no
   network access at run time** (acorn pinned/vendored).
2. The harness emits a structured JSON surface report and a human-readable
   summary covering: compile-error categories, the `WebAssembly.compile`
   validation result, and per-fixture AST divergence (or "structurally equal").
3. On current main the harness **runs to completion and reports** the known
   #1690 validation failure (it does not crash the harness) — i.e. it is robust
   to the surface being red.
4. The harness is documented in the issue/sprint doc and referenced from
   #1711 (triage) and #1712 (acceptance) as the shared tool.
5. Does NOT itself attempt to fix any compiler bug — pure tooling. Must not
   regress test262 (it adds test infra only).

## Notes / scope

- This is the keystone for the `self-hosting-dogfood` goal: #1711 consumes its
  output, #1712 reuses its differential-AST comparison as the acceptance gate.
- Standalone (`--target wasi`) execution of compiled acorn is explicitly a
  *follow-up* (likely a #1711 child) — JS-host execution is the first lap so we
  separate "does acorn run correctly at all" from "does it run host-free".
- Keep the oracle dependency (node-acorn) as a `devDependency` pinned to the
  same version as the `npm pack`-resolved compiled-acorn source, so the two parsers are
  the same acorn and any divergence is a *compiler* bug, not a version skew.

## Implementation (done — PR pending)

Harness lives under `tests/dogfood/`:

- `acorn-pin.json` — pinned acorn@8.16.0 (canonical npm sha1
  `4ce79c89…`, sha512 integrity). Project-lead decision honored:
  pinned `npm pack` tarball, not a vendored copy.
- `fixtures/acorn-8.16.0.tgz` — committed pinned tarball (132 KB). Reproducible
  from a clean checkout with **no run-time network**.
- `setup-acorn.mjs` — verifies the tarball sha1 against the pin (fail-loud on
  drift) and extracts to `tests/dogfood/.acorn/` (gitignored).
- `ast-diff.mjs` — **reusable structural differential-AST comparison**
  (`diffAst`, `diffParse`); the keystone reused by #1712. Ignores
  position fields by default; reports the first divergence as
  `{ path, reason, expected, actual }` with a JSONPath pointer.
- `acorn-harness.mjs` — the compile→validate→run+diff→report loop. Emits
  `tests/dogfood/report/acorn-surface.json` (gitignored) + a human summary.
  Robust to a red surface (records, never crashes).
- `acorn.test.ts` — vitest contract wrapper. The fast `diffAst` + integrity
  assertions run every sweep; the heavy full-acorn compile is opt-in
  (`DOGFOOD_ACORN=1`) and runs the harness as a **child process** so the ~27s
  compile never starves the vitest RPC heartbeat.
- `fixtures/inputs/*.js` — arith / fn / class / control / strings corpus.
- `README.md` — invocation + design decisions.

Invoke: `pnpm run dogfood:acorn` (npm script added).

## Findings on this base (origin/plan-sprint57 = main + sprint docs)

The SAME tarball doubles as the node-acorn oracle (zero version skew). Harness
output (`report.summary`):

- **Compile**: `success=true` in ~27s → 779,953-byte binary. 471 TS diagnostics,
  ALL checker noise (464 `ts-property-noise` "Property does not exist on type",
  3 `ts-possibly-null`, 4 `other` — `comparison has no overlap`,
  `empty-statement body`, 2× `Operator cannot be applied`). None are codegen
  blockers — `compile()` reports success.
- **Validate**: `WebAssembly.compile(binary)` **FAILS** — the surface is RED:
  `Compiling function #110:"__fnctor_Parser_new" failed: any.convert_extern[0]
  expected type externref, found ref.cast null of type (ref null 94)`.
  Notably this is a *different* defect site than the earlier `.tmp/acorn`
  probe (`isInAstralSet` / `f64.lt`), confirming the surface moves between
  builds — exactly why a committed harness is needed. This is the **top
  finding to seed #1711** (a function-constructor/`__fnctor_*` externref
  coercion mismatch, distinct from #1690's index-shift).
- **Run + diff**: skipped-and-recorded (binary invalid → can't instantiate).
  The **oracle self-check passes** (node-acorn-vs-node-acorn: identical sources
  equal, `+`-vs-`-` sources diverge at `$.body[0].declarations[0].init.operator`),
  proving `diffAst` is ready for #1712.

**#1712 (full acceptance) is FAR**, not close: the compiled binary does not yet
validate/instantiate, so no runtime AST comparison has run at all. The next
dogfood step (a #1711 child) is the `__fnctor_Parser_new` externref-coercion
validation failure. Once the binary instantiates, the remaining gap is
marshalling acorn's `parse()` AST back across the JS-host boundary as an
externref so `diffAst` can consume it.
