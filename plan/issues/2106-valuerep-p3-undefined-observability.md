---
id: 2106
title: "value-rep P3: undefined observability — UNDEF_F64 sentinel, union-collapse reversal (flagged), standalone $undefined singleton"
status: in-progress
assignee: ttraenkler/sdev7
sprint: 62
created: 2026-06-11
updated: 2026-06-16
priority: high
feasibility: hard
reasoning_effort: max
task_type: feature
area: codegen
language_feature: type-coercion
goal: core-semantics
related: [2004, 2051, 2030, 2001]
origin: "2026-06-11 analysis program (report 02 phase P3); stub 08-E21"
---

# #2106 — T | undefined collapses to bare T

## Problem

`T | undefined` collapses to bare T at the type mapper, so undefined
becomes NaN/0 in numeric carriers and is unobservable to `===`/`??`/`?.`/
typeof/ToString (#2004 codePointAt, optional-chain representation #2051
slug, #2030 exhausted .value, the #2001 destructuring addendum). In
standalone mode `undefined` and `null` are the SAME bit pattern
(ref.null extern) — indistinguishable by construction.

## Root cause

Union collapse at index.ts:9108-9117 / type-mapper.ts:79-99; observers
never check the existing sNaN sentinel; late-imports.ts:535-543
null-extern fallback. No standalone `$undefined` singleton.

## Fix direction

Per the value-rep spec P3: standardize the sNaN sentinel
(0x7FF00000DEADC0DE) for `number|undefined` carriers with observer
support; reverse union collapse behind a feature flag with measured
blast radius; add the standalone tag-1 `$undefined` singleton global.
Erasure stays for pure ToNumber/ToBoolean sinks (proven sound).

## Acceptance criteria

- `codePointAt(oob) ?? -1`, `=== undefined`, typeof, and stringification
  observe undefined in both modes; null vs undefined distinct standalone
- Flag-gated collapse reversal lands with perf/size measurements

## Ownership reconcile (#2142, 2026-06-15) — READ BEFORE DISPATCH

#2142 reconciled the two-document conflict (this issue's `UNDEF_F64` sentinel
vs #2051's externref widening). Authoritative decision in
[`2142-undefined-rep-owner-reconcile.md`](2142-undefined-rep-owner-reconcile.md#decision-authoritative--2026-06-15-arch1).
Net effect on this issue's scope:

**Decision rule:** widen to **externref + host `undefined`** when the value
must be observable to `===`/`!==`/`typeof`/ToString/`??`; use the **sNaN
sentinel** only inside hot f64 carriers whose sole consumer is
`emitDefaultValueCheck` (destructuring/default-parameter reads, array/tuple
holes).

**Producer list — #2051's sites are REMOVED from this issue.** The
optional-chain short-circuit sites (`a?.b` / `a?.[i]` / `a?.m()`) are owned by
**#2051** (externref widening, per its own `## Implementation Plan`). Do **not**
apply the `UNDEF_F64` sentinel to optional-chain sites — that channel cannot
reach `===`/`typeof`/ToString (verified: `=== undefined` on an f64 is
unconditionally `false`, `binary-ops.ts:479-482`; the sNaN sentinel is observed
*only* by `emitDefaultValueCheck`, `shared.ts:418`).

**This issue's remaining scope after the reconcile is three disjoint pieces:**

1. **General `number|undefined` observability → externref.** For
   `number|undefined` carriers consumed by `===`/`!==`/`typeof`/ToString/`??`
   (NOT optional-chain — those are #2051), widen to externref + host
   `undefined`, composing with the #2072/#2104 value-rep boxing. This is the
   same mechanism #2051 uses, applied to the non-optional-chain producers.
2. **Codify the sNaN sentinel carve-out (erasure stays).** The existing
   `0x7FF00000DEADC0DE` sentinel for default-check / hole carriers
   (`type-coercion.ts:2672`, `emitDefaultValueCheck`) is **kept** — erasure is
   proven sound for pure ToNumber/ToBoolean and default-initializer sinks. Do
   not widen these to externref (hot path, zero observability gain).
3. **Standalone `$undefined` singleton.** Add the standalone tag-1 `$undefined`
   global so `undefined` is distinct from `null` in standalone mode
   (`late-imports.ts:553-571` currently falls both back to `ref.null extern`).
   This is orthogonal to the host-vs-sentinel choice and aligns with #2104's
   JsTag module.

**Do NOT re-claim `codePointAt(oob) ?? rhs`** — already shipped via the
`??`-site NaN special-case (`logical-ops.ts:208-216`, `isCodePointAtCall`);
#2004 is `done`. Neither this issue nor #2051 touches it.

The flag-gated union-collapse reversal (index.ts:9108-9117 /
type-mapper.ts:79-99) stays in this issue's scope and lands with the
perf/size blast-radius measurement as the acceptance criteria require.

## Dupe check

Symptom issues filed; the representation phase is unfiled. New (analysis
program).

## Slice S0 — `any[]` array-element tag recovery (sdev7, 2026-06-16) — SHIPPED

First slice of P3 (the multi-slice S0–S4 plan lives in the #1503/value-rep doc
commits). **Independent of #1503** — it does not depend on `value-tags.ts`.

**Bug (host)**: a boolean (or any non-string primitive) stored in an `any[]`
ARRAY LITERAL lost its JS tag on read-back — `typeof [true][0]` → `"number"`,
`"" + [true][0]` → `"1"` (value preserved: `[true][0] === true`). Root cause:
`[true]` builds `__vec_i32` (booleans lower to i32 and the `any[]` contextual
element type is dropped at the ref-only adoption guard `literals.ts:2886`), then
the i32-vec→`any[]` externref vec coercion boxes by Wasm KIND
(`f64.convert_i32_s; __box_number`) → a JS number.

**Fix** (`src/codegen/literals.ts`, `compileArrayLiteral`, before
`elemKind`/`vecTypeIdx`): when `!hasSpread && elemWasm.kind ∈ {i32,f64}` AND the
literal's `getContextualType` is `Array<any>`/`ReadonlyArray<any>` (type-arg flags
carry `ts.TypeFlags.Any`), widen `elemWasm` to externref. Each element is then
boxed by its own static type via the existing `compileExpression(el, externref)`
path (`__box_boolean` for bool, `__box_number` for number, native string for
string) — the same already-correct route `a.push(true)` uses. No `boxToAny` call
needed. Scoped strictly to `any[]` literals → number[]/string[]/struct[]
byte-identical.

**Validated**: `tests/issue-2106-any-array-element-tag.test.ts` (7/7 host); tsc
clean. **Standalone/WASI unchanged**: `typeof [true][0]` was already `null` and
`"" + [true][0]` already trapped on the base (the standalone `any`-boolean tag
gap is pre-existing, owned by S1/S3) — neither fixed nor worsened here.

Remaining slices S1 (standalone `$undefined`), S2 (sNaN carve-out), S3
(number|undefined→externref), S4 (flag-gated collapse reversal) stay open under
this issue.
