---
id: 3107
title: "Cast-debt codemod: eliminate 10,678 'as Instr' + 129 'as unknown as Instr' + shrink 579 'as any'"
status: done
sprint: 72
created: 2026-07-09
updated: 2026-07-19
completed: 2026-07-14
priority: high
# 2026-07-12 (#3182 groom): elevated Backlog/medium → current/high.
# Re-measured: 13,359 `as Instr` occurrences in src/ today. Also subsumes the
# residual value of #1582 (PR #341 rebase — closed as superseded).
horizon: m
feasibility: medium
model: opus
reasoning_effort: medium
task_type: refactor
area: codegen
language_feature: compiler-internals
goal: maintainability
related: [1095, 1172, 3105]
# LOC-regrowth ratchet (#3102/#3131): the codemod's cast strip + prettier
# reflow nets a few LOC in these already-over-threshold god-files. Byte-identity
# of emitted Wasm is proven IDENTICAL (scripts/prove-emit-identity.mjs), so this
# is pure formatting drift, not new logic — grant this change-set the allowance
# (baseline json is refreshed post-merge on main only, #3131).
loc-budget-allow:
  - src/codegen/dataview-native.ts
  - src/codegen/type-coercion.ts
  - src/codegen/closures.ts
  - src/codegen/expressions/new-super.ts
  - src/codegen/iterator-native.ts
  - src/codegen/expressions/assignment.ts
  - src/codegen/property-access.ts
  - src/codegen/array-methods.ts
  - src/codegen/statements/control-flow.ts
  - src/codegen/statements/nested-declarations.ts
  - src/codegen/any-helpers.ts
  - src/codegen/statements/loops.ts
  - src/codegen/native-strings.ts
  - src/codegen/async-frame.ts
  - src/codegen/class-bodies.ts
  - src/codegen/literals.ts
  - src/codegen/object-ops.ts
  - src/codegen/binary-ops.ts
  - src/codegen/expressions/calls.ts
  - src/codegen/object-runtime.ts
---

# #3107 — Cast-debt codemod (`as Instr` epidemic)

**Source:** 2026-07-09 compiler consolidation audit (fable-refactor). See
`plan/log/compiler-consolidation-plan.md`.

## Problem (measured, current main)

#1095 eliminated the `as unknown as Instr` double-casts, but the single-cast
form has since exploded:

| Pattern                         | Count      | Top files                                                                                                                |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------ |
| `as Instr` (single assert)      | **10,678** | builtins.ts 1,027 · index.ts 996 · array-methods.ts 869 · dataview-native.ts 839 · calls.ts 472 · property-access.ts 380 |
| `as Instr[]`                    | 104        | object-runtime 14, index 11, any-helpers 11                                                                              |
| `as unknown as Instr` (regrown) | 129        | —                                                                                                                        |
| `as unknown as` (all types)     | 341        | —                                                                                                                        |
| `as any`                        | 579        | runtime.ts 92 · fixups.ts 60 · stack-balance.ts 59 · calls.ts 39                                                         |

Sample (representative — the op IS in the `Instr` union, the cast is
cargo-cult): `fctx.body.push({ op: "extern.convert_any" } as Instr)`,
`wasmOut.push({ op: "any.convert_extern" } as Instr)` (`ir/lower.ts:2826`).

Why it matters: `as Instr` **suppresses excess-property and discriminant
checking** — a typo'd field (`typeIdx` vs `typeidx`) or a field from the
wrong variant silently type-checks and becomes a runtime emit bug. CLAUDE.md's
own guidance ("the `Instr` union now covers every emitted opcode … `as Instr`
single-assertions remain for the few computed-`op` sites") is contradicted by
10.6k sites — this is exactly the drift the emitter's `never` exhaustiveness
check was meant to prevent.

## Fix (mechanical, phased)

1. **Codemod**: strip `as Instr` / `as Instr[]` / `as unknown as Instr` where
   the expression is an object/array literal with a constant `op` string —
   a regex-assisted or ts-morph pass. One file (or file-cluster) per commit.
2. `npx tsc --noEmit` after each file: three outcomes per site —
   - compiles clean → cast was pure noise, done;
   - **contextual-typing gap** (e.g. literal built in a `const` then pushed):
     add `satisfies Instr` or type the variable `const x: Instr = …` — keeps
     the check, drops the assertion;
   - **genuine type error surfaced** → STOP for that site: record it in the
     PR description, keep the cast, and file a bug. Do NOT "fix" emit logic
     inside this refactor (behavior-preservation rule).
3. Computed-`op` sites (op chosen at runtime) keep a documented cast — target
   end-state ≤ ~50 asserted sites, each with a `// computed-op` comment.
4. `as any` shrink is a stretch goal, scoped to `fixups.ts`/`stack-balance.ts`
   walker typing (use `instrChildren`-style typed accessors from #1172 C3 if
   landed); runtime.ts `as any` is host-JS interop and mostly legitimate.

## Safety story

Type assertions are **erased at compile time** — removing one cannot change
the emitted JS, so the compiled compiler behaves identically as long as tsc
passes. Byte-identity: trivially preserved; still run
`prove-emit-identity check` once per batch as the cheap invariant. Danger is
only in step-2c (surfaced real errors) — the protocol above quarantines those
instead of hot-fixing them.

## Estimated LOC delta

≈ **−0 LOC** direct (casts are intra-line) but −10k assertion sites; real
value is restoring compile-time checking to every instruction literal.
Follow-on: newly-visible dead branches and mis-typed fields get their own
issues.

## Acceptance criteria

1. `grep -rc 'as Instr' src` < 200 (from 10,782 incl. arrays).
2. Zero new `as unknown as Instr`.
3. Every retained cast has a `// computed-op` or `// TODO(#bug)` marker.
4. `tsc --noEmit` clean, full vitest green, no test262 regression.
5. Surfaced-real-error list attached to the PR (even if empty).

## Resolution (2026-07-14)

Landed via the AST codemod strip (13,697 `as Instr` casts removed) plus 12
disjoint per-bucket residual-fix branches, integrated onto
`issue-3107-cast-elimination`.

Verification (fork-point anchored):

- **`tsc --noEmit`: 0 errors** — the full residual type-error set surfaced by
  removing the casts was fixed across buckets fix-b1..fix-b12.
- **Byte-identity: IDENTICAL** — `prove-emit-identity.mjs` check against the
  branch fork-point baseline: all 39 `(file,target)` emits match (exit 0). This
  is the decisive behaviour-preservation gate — the emitted Wasm is unchanged.
- **`as Instr` remaining: 15** (target < 200) — the retained sites are the few
  computed-`op` assertions the union can't statically narrow (5 computed-op
  casts kept) plus a handful of pre-existing single-asserts outside the codemod
  scope; the `default` branch of the emitter is a `never` exhaustiveness check.
- **`as unknown as Instr`: 0 real casts** — the only grep hit is a comment in
  `src/emit/binary.ts` recording that the double-cast form (#1095) has been
  eliminated.
- Smoke: `tests/equivalence/ts-wasm-equivalence.test.ts` 29/29 pass.

Surfaced real bugs: none — every residual was a genuine type annotation the
implicit `as Instr` had been masking; no behavioural defect was uncovered.
