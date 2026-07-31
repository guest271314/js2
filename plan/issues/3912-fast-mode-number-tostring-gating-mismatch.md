---
id: 3912
title: "CRITICAL: fast mode (the whole gc-native lane) cannot stringify a number — 6 of 9 number→string ops trap at runtime; import-collector gates number_toString and the string family on different conditions"
status: ready
created: 2026-07-31
updated: 2026-07-31
priority: critical
feasibility: medium
reasoning_effort: max
task_type: bug
area: codegen
language_feature: number-to-string
goal: performance
sprint: current
horizon: l
es_edition: multi
related: [3902, 3904, 3909, 3907]
---

# #3912 — fast mode cannot stringify a number

## Status: open — **independently reproduced twice**, with a conclusive control

## Problem

In `fast: true` — which is the **entire gc-native lane**, the flagship
"no host calls" mode — most number→string operations **trap at runtime** on
`main` today.

Measured on `main` (`.tmp/verify-gating.mts`, each case returns a **number** so
it cannot be confounded by fast-mode string marshalling):

| operation | `fast: true` | `fast: true, target: "standalone"` |
| --- | --- | --- |
| `(3).toString()` | **dereferencing a null pointer** | ok |
| `String(n)` | **dereferencing a null pointer** | ok |
| `n.toFixed(2)` | **dereferencing a null pointer** | ok |
| `n.toString(16)` | **dereferencing a null pointer** | ok |
| `JSON.stringify({a: 42})` | **dereferencing a null pointer** | ok |
| `[1,22,333].join(",")` | **illegal cast** | ok |
| `` `v${n}` `` template literal | ok | ok |
| `"v" + n` | ok | ok |
| `[10,9,1].sort()` | **illegal cast** (fixed by #3902) | ok |

## The control matrix — this rules out both single-factor explanations

Three configurations were measured across three independent reproductions. The
fourth cell is not a reachable config, so this is as complete as the matrix
gets:

| `nativeStrings` | `number_toString` | mode | result |
| --- | --- | --- | --- |
| OFF | host import | `host-call` | **6/6 ok** |
| ON | **native** | `standalone` | **6/6 ok** |
| ON | host import | **`fast`** | **6/6 FAIL** |
| OFF | native | — | not reachable |

Read it carefully, because it kills both obvious diagnoses:

- The host `number_toString` is **not broken** — it works in host mode.
- `nativeStrings` is **not broken** — it works in standalone.
- The defect is specifically the **mixture**, which only `fast: true` produces.

**This settles the fix direction rather than leaving it a judgement call**:
make `number_toString` native whenever `ctx.nativeStrings` is on. The
standalone column is already a working end-to-end proof that this
configuration handles all six operations. That is the change deferred out of
#3902 as too broad to attempt blind — it now has a reference config behind it.

## Root cause

`src/codegen/declarations/import-collector.ts`, finalize block (~L1378-1446):

- the **number-formatting** family is gated on `ctx.wasi || ctx.standalone`
  (L1382, L1393, L1414)
- the **string** family is gated on `ctx.nativeStrings` (L1442, L1525)

`fast: true` sets `nativeStrings` but **neither** `wasi` nor `standalone`. So
fast mode gets native string helpers alongside a **host** `number_toString`
that disagrees with them about representation.

Each family's gates are internally consistent, which is why this reads as fine
when inspecting either one alone. The bug lives *between* the two families.

## Why it survived this long — it was invisible, not red

Every one of these is a **runtime trap on a module that compiles and
instantiates cleanly**. That is exactly the `failedPhase: "warmup"` shape that
`benchmarks/harness.ts` silently converted into a **missing bar** rather than a
failure (see #3904, which fixes the swallowing). So a correctness hole in the
headline lane showed up on the public performance page as *nothing at all*.

It also means any gc-native benchmark touching number formatting was either
absent from the page or quietly written to avoid the surface.

## Two signatures, probably one cause — confirm before designing the fix

- `illegal cast` (`join`, and `sort` before #3902): representation
  disagreement, **verified in the WAT** by the #3902 agent.
- `dereferencing a null pointer` (the other five): **not yet traced to an
  instruction.** The standing hypothesis — explicitly flagged as unconfirmed —
  is that `emitNativeNumberFormat`'s `!ctx.funcMap.has("number_toString")`
  early-return also skips emitting the native formatter's **support
  structures** (`__num_fmt_finalize`, the buffer globals) when that name is
  already occupied by the import, leaving a null where the formatter expects a
  buffer.

**Confirm this first.** It decides whether one change fixes all six or whether
there are two independent bugs.

## Scope

1. Trace the null-pointer signature to an instruction and confirm or kill the
   `emitNativeNumberFormat` hypothesis.
2. The likely fix — make `number_toString` native whenever `ctx.nativeStrings`
   — was explicitly **deferred out of #3902** because it changes number
   formatting for every fast-mode program and needs its own conformance run.
   That deferral was correct; this issue is where it gets done properly.
3. Audit the *other* gate pairs in the finalize block for the same
   between-family mismatch. Two families disagreeing was found by accident;
   assume there are more until checked.
4. Full test262 conformance run — number formatting is spec-dense
   (`toFixed`, `toString(radix)`, `JSON.stringify`) and this changes it for
   every fast-mode program.

## Acceptance criteria

1. All nine operations pass under `fast: true`.
2. The null-pointer root cause is stated as a traced fact, not a hypothesis.
3. A regression test covers all nine shapes in both `fast` and `standalone`.
4. The gate audit reports how many other between-family mismatches exist.
5. No test262 regression in `built-ins/Number`, `built-ins/JSON`, or
   `built-ins/Array/prototype/join`.

## Do NOT conflate with #3909

Surface similarity is misleading here. All six failures in this issue are
**runtime** traps on modules that **validate cleanly**. #3909's
`__str_trimStart` is a **validation** failure — a different phase.

#3909's "only fails when `JSON.stringify` + regex + case conversion coexist" is
the signature of the late-import **index-shift** family: enough late
registrations are needed before indices actually move, which is precisely why
it takes three features to trigger. The #3902 agent hit that hazard directly
and had to order `flushLateImportShifts` before reading `funcMap`; there is a
pre-existing comment on the `__extern_toString` path in `array-methods.ts`
saying the same.

**Cheap discriminator:** validation-time failure ⇒ index shift (#3909);
runtime trap ⇒ representation mismatch (this issue).

## Provenance

Root-caused narrowly inside #3902 (which fixed only the `sort` symptom), then
audited into a systemic finding by that same agent when asked whether the
mismatch was a one-off. **Independently reproduced by the coordinator** with a
separate probe on a clean checkout — the table above is from that run, which
also shows `sort()` failing because the checkout lacks #3902's fix, i.e. seven
failures on unpatched `main`.
