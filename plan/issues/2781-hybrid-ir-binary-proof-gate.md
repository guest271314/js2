---
id: 2781
title: "Hybrid IR step 3: Binary `+` string-or-number proof-gate — unboxed numeric add / string concat only when the operand TS types are PROVEN, else SAFE dynamic `+`"
status: done
sprint: 69
created: 2026-06-28
updated: 2026-07-03
completed: 2026-06-28
assignee: ttraenkler/sendev-binproof
priority: medium
horizon: m
feasibility: medium
reasoning_effort: max
task_type: feature
area: codegen, ir
language_feature: binary-expression
goal: correctness
related: [2755, 2762, 2766, 2780, 1530]
depends_on: [2766, 2780]
---

# #2781 — Hybrid IR step 3: Binary `+` string-or-number proof-gate

Third IR-adoption step of the hybrid roadmap
([`docs/architecture/hybrid-soundness-ir-roadmap.md`](../../docs/architecture/hybrid-soundness-ir-roadmap.md)
§(b) step 3; audit **Row 7** in
[`plan/log/hybrid-fastpath-audit.md`](../../plan/log/hybrid-fastpath-audit.md)).
It builds the **operand-type proof** that rows 3 (packed-`i32`) and 5 (unboxed
number locals) will reuse, mirroring the prove-then-specialize shape of #2766
(`lowerElementAccess`) and #2780 (`lowerArrayLiteral` /
`arrayLiteralWideningEscapes`).

## Problem

`lowerBinary` (`src/ir/from-ast.ts`) lowers both operands with an **f64 hint**,
reads the **lowered IR types** (`lt`/`rt` from `typeOfValue`), and dispatches:

- if either lowered IR type is `string` → string path (`emitStringConcat` /
  `emitStringEq`), requiring **both** to be string;
- otherwise both must be the same scalar kind (`f64`/`i32`) → unboxed numeric
  op (`f64.add`, …).

For `+` this is the classic JS unsoundness: `a + b` is **string-concat OR
numeric-add chosen at runtime** (`ToPrimitive` on each operand, then "if either
is a string → concatenate, else add"). The IR picks concat-vs-add from the
**lowered Wasm kind**, but per the Hybrid Invariant (HI) a `T`-directed
specialization must be discharged by a **proof on the TS type**, never the Wasm
kind.

### Why keying on the Wasm kind is unsound (the Row-7 trap — cost two prior R1 parks)

`number`, `boolean` and `symbol` **all** collapse to the same Wasm scalar kind
(`f64` / `i32`) at this site. So the lowered kind cannot, on its own, distinguish:

- a genuine `number + number` (numeric add is correct), from
- an operand whose TS type is `any` / `string` / a `string | number` union that
  the f64-hint lowering opaquely coerced — where JS would `ToPrimitive` and
  possibly **string-concat**, and an unconditional `f64.add` would **miscompile**.

The existing IR-type dispatch incidentally catches *string-literal* operands
(they lower to IR `string`), but it does **not** discharge a real proof: it
trusts the post-lowering kind. HI requires an **explicit operand-type proof**,
read from the TS `TypeFlags`, taken **before** the kind-based dispatch.

## Fix (HI prove-then-specialize, mirrors #2766 / #2780)

Add a reusable TS-type-keyed primitive classifier and gate the `+` fast paths
on it, **before** lowering the operands (so no dead instrs are emitted and the
demotion reason is the explicit HI one, not an incidental downstream throw):

- `classifyPrimitiveProof(t: ts.Type)` → `"number" | "string" | "unprovable"`:
  - `"number"` — `NumberLike` (`Number | NumberLiteral`, incl. numeric enum
    literals), or a union whose **every** constituent is provably number;
  - `"string"` — `StringLike` (`String | StringLiteral`), or an all-string
    union;
  - `"unprovable"` — `any` / `unknown` / `object` / `boolean` / `bigint` /
    `symbol` / `null` / `undefined` / a **mixed** `number | string` union /
    template-literal types / anything else.
- `proveAdditiveOperand(node, cx)` wraps it per operand and returns
  `"no-checker"` when `cx.checker` is absent.

Gate in `lowerBinary`, for `op === PlusToken` only, **before** operand lowering:

- **with a checker** — require a discharged proof that **both** operands share a
  provable primitive class: both `number` (→ unboxed numeric add) or both
  `string` (→ `emitStringConcat`). Any `unprovable`, or a **mixed**
  number/string pair, throws a clean fallback → the function demotes to the
  **SAFE legacy dynamic `+`** (`binary-ops.ts` `emitAnyAdd`, which does
  `ToPrimitive` + string-concat-or-add).
- **no checker** — leave the existing IR-type dispatch unchanged (exactly like
  #2780's no-checker arm): there is no new build whose unsoundness we would be
  masking, and the downstream kind-based checks remain as today's behavior.

### Why this cannot cause a test262 correctness regression

The gate only ever moves a `+` from the IR fast path to the **SAFE legacy**
dynamic `+`, which is the semantic reference. Demoting is correctness-neutral
(at worst a perf/byte deopt). The only currently-succeeding IR `+` cases are
proven `number + number` and proven `string + string` — both keep the fast path
(the proof holds). Mixed / `any` / union `+` already demoted today (via the
incidental "mixed string/non-string" or `requireF64` throws); this slice makes
the demotion reason the explicit HI one and pre-empts the latent
Wasm-kind-trust miscompile if the IR claim scope widens to `any`/union operands.

### Scope / non-goals

- `+=` (`PlusEqualsToken`) is lowered elsewhere (compound assignment), not by
  this `op === PlusToken` gate — out of scope; same operand proof can gate it in
  a follow-up.
- Arithmetic (`-`, `*`, `/`, …) and relational (`<`, …) ops always `ToNumber`
  and are the "easy / already-fine" arm of Row 7; they are left on their current
  path. The **reusable classifier** is built so they (and rows 3/5) can adopt it
  without new infrastructure.
- `bigint` `+` is `unprovable` here → SAFE legacy (bigint is gated off the IR
  anyway).

## Acceptance criteria

- Proven `number + number` (params / literals) keeps the FAST unboxed numeric
  IR path (no Row-7 demotion) and is value-correct.
- Proven `string + string` keeps the FAST `emitStringConcat` IR path (no Row-7
  demotion) and is value-correct.
- A claimed `string + number` (mixed) `+` demotes via the **explicit Row-7
  gate** to the SAFE legacy dynamic `+` and is value-correct (`"v" + 5` ⇒
  `"v5"`).
- `any` / union `+` produce JS-correct values regardless of mechanism.
- No test262 regression in the `merge_group` re-validation (IR change →
  validated full-CI, not scoped).
- `pnpm run check:ir-fallbacks` stays green (refresh the post-claim baseline if a
  playground example legitimately newly demotes).

## Test Results

See `tests/issue-2781.test.ts` — FAST-when-proven (number-add and string-concat,
no demotion via `irPostClaimErrors`) + SAFE-when-not (mixed `string + number`
demotes via the explicit Row-7 gate, value still correct) + value-correctness
for `any`/union `+`.
