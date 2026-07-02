---
id: 2928
title: "Bytecode interpreter core + standalone new Function / indirect eval"
status: backlog
created: 2026-07-02
updated: 2026-07-02
priority: medium
horizon: xl
feasibility: hard
reasoning_effort: max
task_type: feature
area: runtime
language_feature: eval
goal: runtime-eval
sprint: Backlog
parent: 1584
depends_on: [2927]
related: [1715, 1713, 2864, 2865]
---

# #2928 — Bytecode interpreter core + standalone `new Function` / indirect eval

Slice **E** of the runtime-eval roadmap
([docs/architecture/runtime-eval-interpreter.md](../../docs/architecture/runtime-eval-interpreter.md), §6-E).
The WasmGC-native bytecode interpreter — #1584 Phase 1 core. Delivers the first
**standalone** dynamic-code execution: `new Function(dynamicBody)` and indirect
`(0, eval)(s)`, both **global-scope only** (no lexical capture — that is #2929).

## Scope

Global-scope evaluation only, deliberately excluding direct-eval scope capture
(§4.1 / #2929) so this slice needs no environment reification.

1. **Opcode-set ADR** under `docs/adr/` — register+accumulator design (after
   V8 Ignition; rationale: fewer opcodes/op than stack-based, Wasm-locals map to
   virtual registers). ~30 opcodes for Phase 1: arithmetic (with ToPrimitive),
   property `Get`/`Set`, `Call`/`Construct`/`CallMethod`, variable access
   (`LdLocal`/`StLocal`/`LdGlobal`/`StGlobal`), control flow
   (`Jump`/`JumpIfTrue`/`JumpIfFalse`/`Throw`/`TryStart`/`TryEnd`),
   `CallBuiltin <id>`. Document encoding, operand widths, exception-table format.
   Builds on the **#1715** IR→bytecode proof point (done) and the **#1713**
   backend trait seam.
2. **Bytecode emitter** as a second IR backend, gated by a per-function
   may-contain-dynamic flag; walks the same IR the WasmGC backend walks. Bytecode
   stored as a WasmGC array on a function-metadata struct (+ constant pool,
   exception table).
3. **Dispatch loop** authored in the js2wasm-compilable TS subset, compiled by
   js2wasm, with hot-path variables strictly typed (`number` PC, typed struct
   refs for frame/constant-pool) to avoid interpreter-level boxing. Inspect the
   generated WasmGC and note any hot-path boxing in the ADR.
4. **Bidirectional call protocol** — AOT function ↔ interpreted function, **zero
   marshalling**, boxed-value identity preserved (`ref.eq`, roadmap §4.2).
5. **Exception propagation** across the AOT↔interpreter boundary via Wasm EH
   tags (both paths already use EH).
6. Wire `new Function(dynamicBody)` and `(0, eval)(dynamicString)` (indirect) to
   parse via the #2927 Acorn artifact → emit bytecode → run the dispatch loop,
   in **standalone** mode.

## Value-rep (crux) & global access

- `JSValue` = the AOT `$Object` substrate (free bridge — see #2927 / roadmap
  §4.2). `CallBuiltin` targets the generic built-in siblings the #2927 audit
  guarantees.
- Global access: `var`/`function` hoist as properties on the module global
  environment record (globalThis `$Object`, #369), visible to AOT code and vice
  versa (roadmap §4.3). Indirect eval / `new Function` are **always** this
  global scope.

## Non-goals (this slice)

- Direct-eval scope capture → #2929.
- Generator/async opcodes → #2929 (align with #2864/#2865).
- Tier-up (re-AOT-compile hot interpreted functions) → deferred.
- V8/SpiderMonkey-grade throughput — this is the fallback path.

## Acceptance criteria

- [ ] `new Function("a","b","return a+b")(1,2) === 3` in **standalone** mode via
      the interpreter (dynamic body, no host).
- [ ] `(0, eval)("1 + 2") === 3` in standalone mode (indirect eval).
- [ ] `eval("throw new Error('x')")` propagates through the AOT↔interpreter
      boundary into a catching `try/catch`.
- [ ] An AOT function calls an interpreted function and vice versa with identical
      boxed-value identity (a `ref.eq` round-trip test).
- [ ] ≥ 30 test262 eval-positive / Function-positive cases pass under the
      standalone target.
- [ ] A no-eval module stays within 5% of the current size floor; an
      eval-enabled module documents one measured parser+interpreter size figure.
- [ ] Opcode-set ADR committed under `docs/adr/`.

## Notes

Depends on #2927 (parser + generic built-ins). Umbrella: #1584. Goal:
`runtime-eval`.
