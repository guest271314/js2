---
id: 2927
title: "Interpreter foundation: Acorn-via-js2wasm runtime parser + generic-built-in audit"
status: backlog
created: 2026-07-02
updated: 2026-07-02
priority: medium
horizon: l
feasibility: hard
reasoning_effort: high
task_type: feature
area: runtime
language_feature: eval
goal: runtime-eval
sprint: Backlog
parent: 1584
depends_on: [1058, 1710, 2527]
related: [1584, 1715, 1066]
---

# #2927 — Interpreter foundation: Acorn-via-js2wasm + generic-built-in audit

Slice **D** of the runtime-eval roadmap
([docs/architecture/runtime-eval-interpreter.md](../../docs/architecture/runtime-eval-interpreter.md), §6-D, §4.2).
The prerequisite for the standalone bytecode interpreter (#2928): a runtime
parser and a complete generic built-in surface. No bytecode/dispatch yet.

## Problem

The standalone interpreter needs two things that do not exist yet:

1. **A runtime parser.** `eval(dynamicString)` / `new Function(dynamicBody)` need
   to parse ECMAScript at **runtime**, standalone (no host). The build-time
   TypeScript parser is unavailable inside the emitted module.
2. **A generic call surface for every built-in.** The AOT path calls
   type-specialized built-in wrappers (`add_int_int`, typed-array fast paths).
   The interpreter, operating on `any`-typed operands, needs a **generic
   `(any, …) → any` sibling** for each so its future `CallBuiltin` opcode
   (#2928) has a target.

## Part 1 — Acorn compiled via js2wasm (runtime parser)

- Compile Acorn (MIT, ES2024-current, ESTree AST) through js2wasm, building on
  the **#1710 dogfood harness** (already validates + diffs compiled-Acorn AST
  vs node-acorn). Restrict Acorn to **runtime use for dynamic JS source only** —
  the build-time pipeline keeps using the TS parser (eval is always JS, never
  TS).
- **Optional linking (size floor).** A module the static analyzer proves has no
  `eval`/`new Function` must NOT pay Acorn's size cost. Package Acorn +
  interpreter as a **separately-compiled module linked on demand via #2527**
  (core-wasm canonical rec-group linking — shares the `$Object` substrate
  zero-copy; Phase-0 spike is GREEN). This preserves the ~0.2 KB no-eval floor.
- Every Acorn-compilation gap surfaced is filed as a child issue under #1058
  (self-host). Tackle Acorn compilation **first** so gaps surface early.

## Part 2 — generic built-in audit

- Enumerate every specialized built-in the AOT path emits; for each, ensure a
  generic `(any, …) → any` entry exists (or add one) that operates on the boxed
  representation with full runtime type dispatch.
- These generic forms are **shared work** with standalone AOT conformance (a
  dynamically-typed AOT call site needs the same generic entry), so this audit
  is not interpreter-only overhead.
- Produce a coverage report: `builtin → {specialized: y/n, generic: y/n}`, with
  gaps as a checklist that gates #2928 sign-off.

## Value-representation note (the crux — free by construction)

Because the interpreter is compiled by js2wasm (strategy 2a), its `JSValue`
**is** the AOT `anyref`/`$Object` substrate — no marshalling, `ref.eq` identity
preserved across the AOT↔interpreter boundary (roadmap §4.2). This audit is the
*only* real bridge work, and it is completeness, not conversion.

## Acceptance criteria

- [ ] Acorn compiles through js2wasm with no manual source edits; the #1710
      harness reports AST parity on a representative ES2024 corpus.
- [ ] A `parser` artifact is produced and links on demand via #2527; a no-eval
      module's size stays within 5% of the current floor.
- [ ] Generic-built-in coverage report committed; every gap has a tracking item.
- [ ] Acorn-compilation gap issues filed under #1058 where found.

## Notes

Consumes the boxed-any substrate — land after the corresponding value-rep
substrate fixes, don't race them (roadmap §8). Umbrella: #1584. Goal:
`runtime-eval`. This is #1584 scope items 1 + 9, extracted so the parser +
library land and validate before the VM core (#2928).
