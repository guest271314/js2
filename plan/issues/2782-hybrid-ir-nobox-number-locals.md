---
id: 2782
title: "Hybrid IR Row 5 — no-box NUMBER-local proof gate"
status: done
sprint: 69
created: 2026-06-28
updated: 2026-07-03
completed: 2026-06-28
priority: medium
horizon: m
feasibility: medium
reasoning_effort: max
task_type: feature
area: codegen-ir
language_feature: numeric-locals
goal: correctness
parent: 2762
assignee: "ttraenkler/sendev-nobox"
---

# Hybrid IR Row 5 — no-box NUMBER-local proof gate

Row 5 of the hybrid fast-path safety-predicate audit
([`plan/log/hybrid-fastpath-audit.md`](../log/hybrid-fastpath-audit.md)),
governed by the Hybrid Invariant in
[`docs/architecture/hybrid-soundness-ir-roadmap.md`](../../docs/architecture/hybrid-soundness-ir-roadmap.md).
The fourth IR prove-then-specialize slice after R2/#2766 (ElementAccess),
#2780 (ArrayLiteral) and #2781 (Binary). It **reuses the #2781 operand-type
proof** (`classifyPrimitiveProof`).

## The unsound assumption (Row 5)

`lowerVarDecl` (`src/ir/from-ast.ts`) binds a local with the native, **unboxed
`f64`** representation whenever its value lowers to (or is annotated) `f64`. The
fast path _assumes_ "a number-typed local stays unboxed and never needs
identity/boxing at an `any` / union / externref sink." Per the Hybrid Invariant
that `T`-directed specialization must be discharged by a **proof on the TS
type**, not by the lowered Wasm kind: an unboxed `f64` carries **no runtime
tag**, so a value kept unboxed that is actually `any` / `number | string` would
be read with the wrong identity at any dynamic use (`typeof`, `===` against a
string, a boxed-`Number` round-trip).

## The proof `P` and the SAFE fallback

Two HI guards, both reusing #2781's `classifyPrimitiveProof`:

1. **Declaration gate** — `proveUnboxedNumberLocal(name, boundType, cx)`: keep
   the local unboxed only when its TS type is provably a pure number; otherwise
   throw the clean fallback so the function demotes to the SAFE boxed legacy
   lowering (which carries the dynamic tag).
2. **Escape-sink gate** — in `coerceReturnValue`, an unboxed `f64` number
   returned into an `any` (externref) result is the reachable "number value
   sinks to an `any` sink" case. The IR has no box primitive, so it demotes to
   the SAFE boxed legacy lowering (boxes via `__box_number`). Together the two
   keep the value unboxed only while it is provably a pure number **and** box it
   (via demotion) at the proven escape edge.

The SAFE lowering is value-correct either way — the demotion routes the function
to legacy, which already boxes numbers correctly.

## CRITICAL trap (cost two prior R1 parks) — keyed on the TS type, NOT the Wasm kind

`number`, `boolean` and `symbol` all collapse to `f64` / `i32` at the Wasm
level, so the kind cannot distinguish a numeric local from a boolean / `any`
one. The proof therefore keys on the TS **type** via `classifyPrimitiveProof`,
which (by design, from #2781) reports the intrinsic `boolean` (= the
`true | false` union) as **`unprovable`**. Consequently this slice is scoped to
the **`f64` representation only**: gating `i32` locals on the number proof would
demote **every** boolean local. The `i32`-number arm (e.g. `arr.length`,
native-`i32` typed numbers) needs its own TS-type proof and is **deferred** —
see "Deferred" below. `string` / reference locals are unaffected.

## Implementation notes (the WHY, downstream effects, and why it can't regress)

- **Where:** `src/ir/from-ast.ts`.
  - `proveUnboxedNumberLocal` — new helper next to `classifyPrimitiveProof` /
    `proveAdditiveOperand`.
  - Call site in `lowerVarDecl`, placed **after** the annotated-vs-inferred
    validation and **before** the slot/local bindings, so it gates both the
    numeric `slot` path (reassigned `let`) and the plain `local` path on the
    final bound `f64` representation.
  - `coerceReturnValue` — its existing scalar→externref demotion is split so the
    **`f64` (number)** arm carries the explicit Row-5 no-box escape reason; the
    `i32` / `i64` arm keeps its existing "needs the box helper" message (those
    are boolean / bigint, not this slice's concern).
- **No checker → unchanged** (mirrors #2780 / #2781's no-checker arm): with no
  checker there is no specialization whose unsoundness we would be masking.
- **Why it is correctness-neutral / regression-free.** The declaration gate is
  a **forward-looking soundness ratchet**, exactly like #2780's primary widening
  gate. On the current narrow IR claim scope a _claimable_ `f64` local always
  has TS type `number`: a `: any` annotation is **rejected pre-claim** by the
  selector (`isPhase1TypeNode` accepts only `number`/`boolean`/`string`), and
  the f64 hint never opaquely coerces a non-numeric value to `f64` (an `any`
  initializer lowers to externref, not `f64`). So the declaration gate does not
  fire on today's corpus — which is why it cannot regress test262 or grow an IR
  fallback bucket — but it auto-protects when the claim scope widens. The
  reachable, **firing** arm is the escape sink.
- **`check:ir-fallbacks`:** no unintended/post-claim bucket growth (verified).

## Acceptance criteria

- [x] Provably-number local stays unboxed / fast (IR-claimed, no Row-5
      demotion), value-correct — annotated, inferred, param-arithmetic, and the
      mutated-`let` numeric slot path.
- [x] Boolean (`i32`) and string locals are NOT demoted (the Wasm-kind trap is
      avoided).
- [x] A number value escaping to an `any` result demotes via the explicit Row-5
      gate and stays value-correct (boxed SAFE legacy lowering).
- [x] `proveUnboxedNumberLocal` reuses `classifyPrimitiveProof` and keys on the
      TS type, never the Wasm kind.
- [x] `pnpm run check:ir-fallbacks` clean; broad-impact validated via full
      CI / `merge_group`.

## Deferred (follow-up)

- The **`i32`-number** arm (numbers that lower to `i32` — `arr.length`,
  native-`i32` typed numbers): needs a TS-type proof that distinguishes an
  `i32`-number from a `boolean`, since `classifyPrimitiveProof` deliberately
  reports `boolean` as `unprovable`. Out of scope here to avoid the
  demote-every-boolean trap.

## Tests

`tests/issue-2782.test.ts` — FAST (proven-number locals stay unboxed, no
demotion), the boolean/string non-gating cases, and SAFE (number → `any`
escape demotes via the Row-5 gate, value-correct).
