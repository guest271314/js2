---
id: 2790
title: "Hybrid IR — no-box NUMBER-local proof gate, i32 arm (#2782 fast-follow, unblocked by #2785)"
status: done
sprint: 69
created: 2026-06-28
updated: 2026-07-03
completed: 2026-06-28
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: feature
area: codegen-ir
language_feature: numeric-locals
goal: correctness
parent: 2762
assignee: "ttraenkler/agent-af367ef55d7ab6b0d"
---

# Hybrid IR — no-box NUMBER-local proof gate, i32 arm

The fast-follow that #2782 explicitly **DEFERRED** and #2785 now **unblocks**.
Part of the hybrid fast-path safety-predicate audit
([`plan/log/hybrid-fastpath-audit.md`](../log/hybrid-fastpath-audit.md)),
governed by the Hybrid Invariant in
[`docs/architecture/hybrid-soundness-ir-roadmap.md`](../../docs/architecture/hybrid-soundness-ir-roadmap.md).

## Context

[#2782](2782-hybrid-ir-nobox-number-locals.md) added `proveUnboxedNumberLocal`
in `lowerVarDecl` (`src/ir/from-ast.ts`), keeping a number local UNBOXED only
when its TS type is provably a pure number — but **scoped to the `f64`
representation ONLY**. It DEFERRED the `i32`-number arm because boxing an `i32`
local to `externref` at an escape sink was type-blind (always `__box_number`),
which would corrupt an `i32`-backed boolean.

[#2785](2785-hybrid-type-aware-box-primitive.md) fixed exactly that:
`coerceType(i32 → externref)` now boxes by the TS brand
(`boolean` → `__box_boolean`, `symbol` → `__box_symbol`, else `__box_number`).
So an `i32`-backed value can now be kept unboxed AND boxed correctly on escape.

## The fix

Extend `proveUnboxedNumberLocal` (the no-box declaration gate) from `f64`-only
to also cover the `i32` representation. The `i32` kind hosts **two** sound,
brand-determinable primitives that may be kept unboxed:

- a `number` (`arr.length`, a native-`i32` typed number) — boxes via
  `__box_number` at the escape edge;
- a `boolean` — boxes via `__box_boolean` (the #2785 fix).

Demote only a **genuinely-unprovable** `i32` local (`any` / `unknown` / a mixed
union — no determinable brand for the escape box) to the SAFE legacy lowering.

### The trap (why #2782 deferred this)

`classifyPrimitiveProof` (reused from #2781) deliberately reports the intrinsic
`boolean` (the `true | false` union) as **`"unprovable"`** — a boolean is NOT a
number, so it must never enter the *number* no-box path (which boxes
`__box_number`, corrupting it). The naive "gate `i32` on
`classifyPrimitiveProof === 'number'`" would therefore demote **every** boolean
local, routing every boolean-local function to legacy and growing an IR-fallback
bucket. The fix keys on the TS *type*: a `boolean` is recognised by a SEPARATE
`isProvablyBoolean` proof and kept unboxed; the *number* proof never swallows it.

## Implementation

- **`src/ir/from-ast.ts`** only.
  - New `isProvablyBoolean(t)` helper — recursive, mirroring
    `classifyPrimitiveProof`'s union handling, matching `ts.TypeFlags.BooleanLike`.
  - `proveUnboxedNumberLocal` extended: out-of-scope unless `f64` / `i32`; with a
    checker, `classifyPrimitiveProof === "number"` keeps either kind; an `f64`
    non-number demotes; an `i32` non-number keeps iff `isProvablyBoolean`, else
    demotes. `i64` (bigint) / ref / string remain out of scope.
  - The `lowerVarDecl` demotion message generalised to `f64`/`i32` (boolean noted
    for the i32 arm).
- The **escape side already exists**: `coerceReturnValue`'s `i32`/`i64` escape
  sink demotes an unboxed scalar flowing into an `any` result to legacy, where
  #2785's type-aware box picks `__box_boolean` / `__box_number` by brand. No
  change needed there — #2790 is the declaration-gate counterpart.

## Why it is correctness-neutral / regression-free

Empirically, IR-claimed `i32` locals on today's corpus are predominantly
**booleans** (native-`i32` annotations are not IR-claimed; `arr.length` numbers
coerce to `f64` under the default hint). For those, the new gate is **identical**
to the pre-change behavior (booleans kept, numbers kept) — the only NEW demotion
is for a genuinely-unprovable `i32` local (`any` / mixed union), which does not
occur in the current corpus. So, like #2782's `f64` declaration gate, this is a
**forward-looking soundness ratchet** that does not fire on today's corpus
(verified: no `check:ir-fallbacks` bucket growth, no post-claim demotions) yet
auto-protects when the claim scope widens. Demote-to-safe is value-correct.

## Acceptance criteria

- [x] An `i32`-backed NUMBER local stays unboxed and is value-correct; an
      escaping `i32`-number boxes via `__box_number` (correct value).
- [x] An `i32`-backed BOOLEAN local is NOT caught by the number gate (no
      no-box-number demotion) and, on escape to an `any` sink, boxes via
      `__box_boolean` — the host sees a real boolean, not `1`.
- [x] The gate keys on the TS type, never the Wasm kind; number and boolean
      locals coexist without cross-corruption.
- [x] The `f64` arm (#2782) is unchanged; `pnpm run check:ir-fallbacks` clean
      (no bucket growth / post-claim demotions); broad-impact validated via full
      CI / `merge_group`.

## Tests

`tests/issue-2790.test.ts` — the i32 boolean trap guard (boolean not
number-demoted), the HEADLINE boolean-escape → `__box_boolean` correctness, the
i32/f64 number-escape → `__box_number` correctness, TS-type keying (no
cross-corruption), and the #2782 f64 arm intact.
