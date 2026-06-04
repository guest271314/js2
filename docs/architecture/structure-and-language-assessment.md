# Assessment: file/folder structure & language choice

> An expert-consensus assessment of **this compiler's** repository structure
> and its implementation-language choice, grounded in a survey of the actual
> tree (2026-06-04). Companion to
> [`compiler-design-lessons.md`](compiler-design-lessons.md) (general
> patterns) and [`codegen-axes.md`](codegen-axes.md) (the two-axis model).
> Vendor-neutral: no competitor projects are named — only the patterns.

## What was surveyed

- `src/` is **~181k lines of TypeScript** across:
  `checker/ → ir/ → codegen/ + codegen-linear/ → emit/ → link/ → runtime/`
  (plus `compiler/`).
- Language/build: **TypeScript**, `target: ES2022`, `module: ESNext`, ESM,
  `strict: true`; built with Vite (lib) + esbuild (bundle); tested with
  vitest; optimization delegated to Binaryen (`wasm-opt`); scripts via `tsx`.
- Largest source files (lines): `codegen/expressions/calls.ts` **11,092**;
  `codegen/index.ts` **10,986**; `runtime.ts` **10,092**;
  `codegen/array-methods.ts` 6,479; `codegen/expressions/assignment.ts`
  5,620; `codegen/native-strings.ts` 5,613; `codegen-linear/index.ts` 4,822;
  `ir/from-ast.ts` 4,406.

---

## Folder structure — strong skeleton, debt concentrated in a few god-files

### What the consensus would praise

- **Textbook phase separation.** The `src/` layout maps cleanly onto the
  classic pipeline: front-end (`checker`), middle-end (`ir`), pluggable
  backends (`codegen` = WasmGC, `codegen-linear` = linear memory), binary
  `emit`, a real object-file `link`er, and `runtime`. This is the
  "narrow waist with the IR in the middle, backends hanging off it" shape the
  IR literature endorses — and, crucially, **the directory layout matches the
  documented conceptual model** (rarer than it should be).
- **The architecture is written down** (`codegen-axes.md`, `ir-adoption.md`),
  and the two axes (front-end: direct vs IR; backend: WasmGC vs linear) are
  explicit. "Is the mental model documented, and does the tree reflect it?"
  is heavily weighted by reviewers — this passes.
- **Clean top-level hygiene** — `tests/ docs/ plan/ scripts/ benchmarks/
  website/` all live outside `src/`.

### What they'd flag

- **God-files (the #1 structural concern).** `calls.ts` (11k), `codegen/
  index.ts` (11k), `runtime.ts` (10k), `array-methods.ts` (6.5k),
  `assignment.ts` (5.6k). The consensus threshold for "a change can be
  understood in isolation" is ~1–2k lines; these are 5–10× over, driving
  review cost, merge-conflict rate, and the loss of the nanopass
  "understood-in-isolation" property. This is the visible *"hacks accumulate
  in direct codegen"* symptom — **already tracked** as #1098 (hack inventory)
  and #1172 (modularity audit), and it's exactly what the typed-IR migration
  is meant to dissolve. Known debt, not a blind spot — but it's the
  highest-friction part of the tree.
- **Two parallel mega `index.ts`** (`codegen/` 11k + `codegen-linear/` 4.8k)
  are the `features × targets` duplication the typed-IR waist is designed to
  collapse — structure faithfully reflecting an in-progress migration.
- **Asymmetric backend naming.** `codegen/` (unmarked default) vs
  `codegen-linear/` (suffixed) subtly encodes "linear is secondary," which
  contradicts the project's own stated principle that the two backends are
  *alternatives, not rivals*. A neutral pairing (`backend/wasmgc` +
  `backend/linear`, or at minimum `codegen-wasmgc/`) would make the tree say
  what the doc says. Minor but real. *(Note: a large directory rename is a
  history/merge-conflict cost on a busy tree — weigh against the clarity
  gain; may be best bundled with the #1172 modularity work.)*
- **Ambiguous `compiler/` vs `codegen/` vs `emit/` boundaries** for a
  newcomer. A one-line module-header / `README` per `src/` subdir stating its
  contract is cheap and pays off (ties to the `contributor-readiness` goal).

### Structure grade

Strong, idiomatic skeleton; the debt is concentrated in a handful of
oversized direct-codegen files, which is already on the roadmap to dissolve
via the IR. The cheap, net-new, not-yet-tracked items are the **backend
naming asymmetry** and **per-subdir module-contract READMEs**.

---

## Language choice (TypeScript) — well-justified, near-canonical for this compiler

The expert heuristic is *"match the implementation language to your dominant
leverage point."* For a TS→Wasm compiler, that point is decisive:

### Why it's the right call here

- **The `typescript` package is reused as the front-end** — its parser, AST,
  and type checker. The single most expensive component of a TS→Wasm compiler
  (a correct TS parser + type system) is **eliminated**. Rewriting in a
  systems language would mean reimplementing or FFI-wrapping that checker.
  This alone justifies the choice.
- **Source language == implementation language → self-hosting is on the
  table** (there's a `self-hosting-dogfood` goal and a `dogfood:acorn`
  harness). A genuine strategic asset.
- **Largest contributor pool** (matters for an open Wasm/JS-adjacent project)
  and **first-class Binaryen bindings**. Fast iteration (vitest/tsx/esbuild).

### The honest tradeoffs

- **TS's type system is unsound and structural** — not the ideal substrate
  for "make illegal states unrepresentable." No true sum types / exhaustive
  pattern-matching (simulated with discriminated unions + `never`), and the
  escape hatches surface concretely as the **~158 `as unknown as Instr`
  casts** (#1095) — TS fighting the IR model. A nominal-ADT language would
  catch more compiler bugs at compile time and make the nanopass style less
  boilerplate-heavy. **The compensating discipline is already in place:**
  discriminated unions + the runtime IR verifier (`src/ir/verify.ts`) buy
  back the guarantees the type system can't give — which is exactly why
  hardening the verifier (R1 / #1850) is high-value, and why retiring the
  cast budget (#1095) matters.
- **Performance / memory ceiling.** A compiler is alloc-heavy; a GC'd Node
  runtime has throughput and heap ceilings a systems language doesn't — felt
  already as OOM on the full suite and `COMPILER_POOL_SIZE` budgeting. Fine
  at current scale. If it ever bottlenecks, the escape valves are
  self-hosting hot paths to Wasm, or a small perf-critical core in a systems
  language — neither warranted yet.

### Verdict

For a TS→Wasm compiler specifically, TypeScript is a defensible, near-
canonical choice: the front-end reuse + self-hosting upside dominates the
weaker compile-time guarantees and the runtime ceiling. The discipline that
makes it work is precisely what's already in flight — a strong IR verifier
(compensating for TS's unsoundness) and retiring the `as unknown as` cast
budget.

---

## Cheap, net-new follow-ups surfaced by this assessment

Now tracked (the god-file debt is already #1098/#1172):

1. **Backend naming symmetry** — **#1860** — rename so neither backend reads
   as the "default" (`backend/gc` + `backend/linear`). `maintainability`,
   low effort. Consider bundling with #1172 to avoid a standalone large
   rename.
2. **Per-`src/`-subdir module-contract READMEs** — **#1859** — one short
   header per subdir (`checker`, `ir`, `codegen`, `codegen-linear`, `emit`,
   `link`, `runtime`, `compiler`) stating its responsibility and what it
   may/may not depend on. `contributor-readiness`, low effort.
