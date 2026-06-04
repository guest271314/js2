---
id: 1858
title: "Compiler correctness & production-hardening audit (fail-loud, validate, gate)"
status: ready
created: 2026-06-04
updated: 2026-06-04
priority: high
feasibility: hard
reasoning_effort: max
task_type: refactor+correctness
area: codegen
goal: maintainability
sprint: Backlog
related: [1561, 1172, 1530, 1376, 1784, 1785, 1815, 1816, 1817, 1820]
---
# #1858 — Compiler correctness & production-hardening audit

Second-pass review of the compiler, focused on **correctness and production risk**
(not the modular-decomposition concern tracked in #1561). Conducted 2026-06-04 by
six independent hostile reviewers, one per risk dimension. All `file:line`
anchors below were verified against HEAD; findings are tagged **PROVEN** (confirmed
by code/repro) or **LIKELY** (inferred). Already-filed issues are cross-referenced
rather than duplicated.

## Verdict

This is an impressive research compiler with a **demo-grade correctness posture**.
It is **not** defensible to a compiler engineer, nor safe on untrusted/diverse
input, today — because of one systemic design choice that runs through every layer:

> **When something doesn't fit, the compiler silently produces a wrong answer
> instead of failing loudly — and the CI gates are tuned to let those silent wrong
> answers ship.**

## Root cause: "prefer a wrong answer over a loud failure", at four layers

The same anti-pattern was found independently by four reviewers:

| Layer | Mechanism | Evidence |
|---|---|---|
| Codegen | `stack-balance` **drops a type-mismatched value and substitutes `0`/`null`** ("lossy but valid") | `src/codegen/stack-balance.ts:709-755` — PROVEN repro: a `()->f64` body producing `ref.null.extern` is rewritten to `…; drop; f64.const 0` → returns **0** |
| IR front-end (**ships by default**) | IR build/lower failures **demoted to `severity:"warning"`**, silent fallback to legacy | `src/compiler.ts:666` (`experimentalIR !== false`) + `src/codegen/index.ts` (`severity: isStrict ? "error" : "warning"`; strict-list closed by default) |
| Runtime | `resolveImport` default case **returns a no-op `() => {}`** | `src/runtime.ts:9266` |
| CI | required gate only blocks a **catastrophe (≥200 regressions)**; the zero-tolerance gate is **not required** | `.github/workflows/test262-sharded.yml:566`, `docs/ci-policy.md:47` |

And **nothing verifies the emitted Wasm is valid**: there is no
`WebAssembly.validate()` in the production pipeline; the "typed IR" verifier
(`src/ir/verify.ts`) checks SSA *shape* but **never typechecks operands**; and
**169 `as unknown as Instr` + 490 `as any`** (both grown past the CLAUDE.md
figures, concentrated in the emit path) blind `tsc`. So a type error must survive
to `instantiate`, be hit by a test, *and* exceed 199 siblings before anyone notices.

## CRITICAL findings (miscompiles / corruption)

| # | Finding | File:line | Status |
|---|---|---|---|
| C1 | **stack-balance silently returns `0`/`null` on type mismatch** — turns loud validation failures into silent wrong answers; **amplifies every other codegen bug** (the keystone) | `stack-balance.ts:709-755` (`fixBranchType`), reached via `fixBranch:830`, whole-fn fixup `:2381` | NOVEL, PROVEN |
| C2 | `Array.prototype.sort` **ignores the user comparator** and uses numeric (not lexicographic) default order | `array-methods.ts:5768`, `timsort.ts:441` | filed **#1816**, PROVEN (WAT: `call_ref count: 0`) |
| C3 | **IR ternary → eager Wasm `select`**: both arms evaluated → infinite recursion on `n<=1?1:n*f(n-1)`; `&&`/`||` lose short-circuit | `ir/from-ast.ts:3464-3482`, `:3676` | filed **#1820**, PROVEN |
| C4 | **IR ships by default but its failures are warnings** → silent legacy fallback, no user signal, engineered to keep CI green | `compiler.ts:666`, `codegen/index.ts:1254-1261` | NOVEL, PROVEN |
| C5 | **No `WebAssembly.validate()` in the pipeline + IR verifier never typechecks operands** → invalid Wasm only caught at `instantiate`, only if a test hits it | `ir/verify.ts:112-133`, `emit/binary.ts` | NOVEL, PROVEN/LIKELY |
| C6 | **`try/finally` else-branch branch depths never bumped** — `bumpOuterBranchDepths` reads `(instr as any).elseBody`; the IR `if` field is `else` → wrong jump target / validation failure | `statements/exceptions.ts:55` (field is `else` per `ir/types.ts:224`) | NOVEL, PROVEN |
| C7 | **Standalone enumerates object keys in hash order** (host = spec/insertion order) → `JSON.stringify`/`for-in`/`Object.keys`/`entries`/`values`/`assign` reorder by `--target` | `object-runtime.ts:1099-1102` vs `runtime.ts:5573` | NOVEL, PROVEN (comment admits it) |
| C8 | **`(x >>> 0)` sign-extends** in the i32 fast path → negative for high-bit values (breaks the canonical ToUint32 idiom) | `binary-ops.ts:1247-1252,1330`; correct path at `:2548` | filed **#1817**, LIKELY |
| C9 | `resolveImport` **default → no-op**; standalone **`isFrozen`/`isSealed` wrong** (one bit, ignores descriptors + empty-object rule) | `runtime.ts:9266`; `object-runtime.ts:1943-1945,1963-2001` | NOVEL, PROVEN |
| C10 | **CI lets up to 199 real miscompiles merge green per PR**; **no fuzzing / property / generative differential testing**; negative tests never check error *type* | `test262-sharded.yml:566`, `tests/test262-runner.ts:2541-2625` | NOVEL, PROVEN |

## HIGH findings

- `Array.prototype.splice` **drops inserted items** (args 2+ ignored) — `array-methods.ts:4421` — filed **#1815**, PROVEN.
- **Call-graph closure ignores `ref.func`**: address-taken functions (`arr.map(foo)`, `const g = foo`) get IR-rewritten signatures while a legacy trampoline still calls through the old type → invalid/UB — `ir/select.ts:1932-1979`, `ir/integration.ts:685-698` (the #1602 family) — LIKELY.
- **Exported unannotated functions** get signatures inferred from *internal* callers, not their host contract → host call with off-contract args silently yields `NaN`/wrong — `ir/select.ts:1354`, `codegen/index.ts:552` — LIKELY.
- **Standalone/WASI `Number.prototype.toString()` rounds fractions to 6 digits** → `String(0.1+0.2)` = `"0.3"`, `(1/3).toString()` = `"0.333333"`, `String(1e-7)` = `"0"` — `number-format-native.ts:470-562` (gated `declarations.ts:943`) — PROVEN. Needs shortest-round-trip dtoa (Ryū/Grisu).
- **Standalone/WASI `parseFloat`/`StrToNumber` naive `*0.1` accumulation** loses last-ULP precision — `parse-number-native.ts:299-335` — LIKELY.
- **`C.prototype.method` via JS-side prototype access throws** "not yet supported" — `runtime.ts:3368-3381` — PROVEN.
- **`wasi` vs `standalone` disagree**: dynamic objects compile under `standalone`, hard-refused under `wasi` (gating is `ctx.standalone`-only) — `compiler.ts:955-957`, `late-imports.ts:308` — PROVEN.
- **Standalone refuses `hasOwnProperty`, `getOwnPropertyDescriptor`, `getPrototypeOf`, `for-in`, accessor `defineProperty`** (all work in host) — `late-imports.ts:52-70` — PROVEN.
- **`instrDelta` falls back to `0`** on unresolved `call`/`struct.new`/`call_ref` → poisons stack simulation, `fixBranch` then corrupts correct code — `stack-balance.ts:294,333,343,353,435` — LIKELY.
- **163 of 169 `as unknown as Instr` casts are cargo-cult** (op already in the union) — disable field checking on the most safety-critical ops (`struct.get`/`array.get`/`i64.const`); plus all instruction traversal is `(instr as any).body` (no typed child accessor) — `map-runtime.ts`(76), `walk-instructions.ts:47`, `stack-balance.ts`, `fixups.ts` — LIKELY.
- **`u32` LEB128 encoder truncates ≥2³² and encodes `-1` as `0xFFFFFFFF`** — last line of defense emits plausible-but-wrong bytes instead of throwing — `emit/encoder.ts:14-21` — PROVEN.
- **Late-import shift walker never walks `global.init` / `element.offset`** — latent stale-index bug the moment a `ref.func` is lowered into a global init — `codegen/index.ts:7525-7588` — LIKELY (no producer today).
- **Host ToPrimitive swallows `WebAssembly.RuntimeError`** from user `@@toPrimitive`/`valueOf` and falls through (must propagate per §7.1.1) — `runtime.ts:1907-1975` — LIKELY.
- **AnyValue struct→f64 reads `f64val` for string/object tags** (no ToNumber/ToPrimitive); `f64val` is hard-coded `0` at box time — `type-coercion.ts:1271-1275`, `any-helpers.ts:296-326` — LIKELY.
- **Linear backend is a stale 4,822-line second compiler with zero differential coverage vs WasmGC** — `codegen-linear/index.ts:40` — LIKELY.
- **QA**: 99 grandfathered known-wrong behaviors shipping (`scripts/equivalence-baseline.json`); the differential harness is `continue-on-error: true` against a 2-week-stale 104-program baseline (`diff-test.yml:38`); `--optimize` is functionally unverified (the one test checks only header magic bytes); CLAUDE.md's QA section is stale and references a `tests/equivalence.test.ts` that no longer exists.

## What a compiler engineer will grill us on (credibility)

1. **"Typed, verified IR"** — the verifier never typechecks operands; 163 cargo-cult casts and `(instr as any)` traversal defeat the union; no `WebAssembly.validate()`.
2. **"How do you know it's correct?"** — test262 is largely a dashboard; the real gate only catches ≥200-test catastrophes; **zero fuzzing/property/differential-at-scale**; negative tests pass on *any* failure regardless of error type; 99 grandfathered failures.
3. **"Dual-mode parity"** is marketing — standalone is a partial, *divergent* reimplementation (key order, `isFrozen`, missing `hasOwnProperty`), and the two no-host targets don't agree with each other.
4. **"You ship `-O` but never execute the optimized binary in any test."**

## Remediation plan

### P0 — stop laundering wrong answers + add validation (do first)
- **P0.1 (C1)** `stack-balance.fixBranchType`: replace drop-and-default with **real coercion** (`__box_number`/`__unbox_number`, mirroring `coerceArgType` at `stack-balance.ts:1235-1304`) for f64↔externref / i32↔externref; **`throw`** for genuinely impossible mismatches (ref→f64). **Risk: a blind `throw` will turn today's silent-wrong "passes" into compile errors and may trip the catastrophic gate — must be CI-measured; back off to coercion-where-possible + throw-only-on-impossible.** Senior-dev.
- **P0.2 (C9)** `resolveImport` default → `throw` with the unhandled intent type. Measure.
- **P0.3 (C5)** Add `WebAssembly.validate()` to dev/test compiles (fail the compile on invalid output); add operand ValType checking to `ir/verify.ts` (`operandIrType` is already computed). Surface, don't gate-prod, until measured.
- **P0.4 (C4)** Emit a concise per-fallback diagnostic when the IR path falls back (the report channel the code comment already says was deferred).
- **P0.5 (C6)** `exceptions.ts:55` `elseBody` → `else` (+ route through `walkChildren`); add a value-asserting regression test (`try/finally` with an else-branch `break outer`).
- **P0.6** `emit/encoder.ts` `u32`: `throw` on `< 0` or `> 0xffffffff`.

### P1 — make CI actually gate correctness
- Make the **zero-tolerance regression gate required** (infra exists; `docs/ci-policy.md:47`); use the merge-base baseline to kill drift false-positives.
- Add **property-based differential testing** (`fast-check`: random expr/args → compile→run vs Node→assert equal). Highest-leverage missing safety net.
- Add an **IR-on vs legacy** differential lane and a **WasmGC vs linear** lane; un-stale + auto-refresh the V8 differential baseline; run a test262 slice with `optimize:true` and diff.
- Ratchet `as any` / `as unknown as Instr` counts like the IR-fallback budget; add the 6 genuinely-missing ops to the `Instr` union and delete the cargo-cult casts; add a typed `instrChildren` accessor.

### P2 — close known correctness holes
- Ship #1815 (splice), #1816 (sort), #1817 (`>>>`), #1820 (ternary).
- Standalone key insertion-order (C7); standalone `isFrozen`/`isSealed` + descriptor updates (C9); shortest-round-trip dtoa for standalone numbers; correctly-rounded standalone `parseFloat`.
- Fix the `ref.func`/address-taken signature-divergence (HIGH) and exported-function-contract inference (HIGH).

### P3 — honesty / hardening
- Decide whether "dual-mode parity" is a real guarantee (then test both targets against the same corpus) or **downscope the claim**; align `wasi`/`standalone` object models.
- Implement standalone `hasOwnProperty`/`getOwnPropertyDescriptor`/`getPrototypeOf`; make `C.prototype.method` dispatch into the compiled method instead of throwing.
- Fix the stale CLAUDE.md QA section (dead `tests/equivalence.test.ts` reference); attach owners + decay targets to the 99 grandfathered failures.

## Acceptance criteria
- [ ] P0.1–P0.6 landed; no catastrophic test262 regression (net measured in CI); C1/C6 covered by value-asserting tests.
- [ ] `WebAssembly.validate()` runs in test compiles; at least one previously-silent invalid-Wasm case now fails loudly.
- [ ] A property-based differential test harness exists and runs in CI.
- [ ] The zero-tolerance regression gate is a required check (P1).
- [ ] This issue's findings are each either fixed, filed as a child issue, or explicitly accepted with rationale.

## Provenance
Six-reviewer hostile audit, 2026-06-04. Reviewer transcripts summarized above;
all line numbers verified against HEAD. Companion to #1561 (modular decomposition).
