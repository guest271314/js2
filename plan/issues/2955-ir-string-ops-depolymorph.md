---
id: 2955
title: "De-polymorph the IR front-end on string mode: abstract IR string ops resolved at lower time"
status: ready
sprint: current
created: 2026-07-02
updated: 2026-07-03
assignee: ttraenkler/agent-a4461
priority: medium
horizon: m
feasibility: medium
reasoning_effort: high
task_type: refactor
area: ir
language_feature: strings
goal: ir-full-coverage
related: [2953, 679, 2949]
origin: "2026-07-02 July Fable audit §5 (identical source builds different IR per string mode)"
---

# #2955 — identical source builds different IR depending on nativeStrings

## Problem

`src/ir/from-ast.ts` branches on `resolver.nativeStrings?.()` at
:2620, :2874, :2938, :3173, :3309 (and `lower.ts` consults it at :173,
:186): with native strings on, IR construction emits `__str_*` helper
calls; with host strings, it emits host-import shapes. So the **front-end
IR is representation-polymorphic** — a violation of the north star ("one
front-end; backends/modes differ at lowering") _within_ the WasmGC family,
and a drift breeding ground (June audit D4): every new string feature must
be implemented twice at IR-build time.

## Approach

1. Introduce abstract IR string ops (e.g. `IrInstrStrConcat`,
   `IrInstrStrCompare`, `IrInstrStrLen`, `IrInstrStrIndex`,
   `IrInstrStrFromLiteral` — audit the 5 branch sites for the exact op
   set) emitted unconditionally by from-ast.
2. Resolve the mode in `lower.ts` (or the emitter, coordinating with
   #2953's trait discipline): native mode lowers to `__str_*` helpers,
   host mode to the wasm:js-string imports — exactly the sequences emitted
   today, byte-identical per mode.
3. Verifier: string ops type as the existing string ref types; no new
   verifier surface beyond op signatures.

## Acceptance criteria

- from-ast.ts contains zero `nativeStrings` reads (grep-gated).
- Same source produces identical IR (structural compare) in both string
  modes; per-mode lowered bytes identical to before.
- Equivalence suite green in both modes; string-heavy test262 sample
  net-zero.

## Implementation analysis + Slice 1 (2026-07-03, dev)

Measured against `origin/main` @ e29c8c5b2. The five `nativeStrings` reads in
`from-ast.ts` are **not one uniform "5 abstract string ops" set** (the Approach
section's op list — `IrInstrStrConcat`/`StrCompare`/… — does not match these
sites; those ops are already abstract elsewhere). Each read is a *different
kind* of polymorphism, with a different byte-inert path to lower time:

| site | function | polymorphism kind | de-polymorph blocker |
| ---- | -------- | ----------------- | -------------------- |
| ~2792 | `coerceToExpectedExtern` | string→externref host-call arg coercion; **native throws (demote)** | native string CANNOT flow into a host-string externref position, so the throw is a **claim/demote decision** — must move to `select.ts` capability (#2135), not lower time. Not byte-inert as a plain "always coerce". |
| ~2912 | number `.toString()` host import | claims `f64.toString()` **only in host mode** | native has no native number formatter yet; the mode read is a real capability gate. Needs native number-format feature before it can move. |
| ~3142 | `lowerStringMethodCall` | helper name `__str_X` vs `string_X` + i32/f64 arg reps + native-mode bails + sentinel padding | large mode-specific decision table; a faithful move relocates the whole table (incl. #2002/#1248 special-cases) to `lower.ts`. Own slice. |
| **3467** | **`coerceYieldValueToExternref`** | **string→externref coercion for generator-yield / iter-host** | **NONE — cleanly byte-inert. DONE in Slice 1.** |
| ~3603 | `lowerForOfStatement` string arm | native char-loop vs iter-host for-of strategy | both strategies are big loop builders living in from-ast; moving the *selection* to lower time means the lowerer owns both loop builders. Own slice. |

### Slice 1 (landed by this PR) — the coercion-elision site (3467)

The `coerce.to_externref` op unconditionally emitted `extern.convert_any`,
which is **invalid over an already-externref operand** (externref is not an
anyref subtype). That is exactly why from-ast guarded the coercion sites with
`!nativeStrings` — to avoid emitting the convert over a host-mode string
(externref). Fix: move the "is the operand already externref?" decision to
**lower time** (`lower.ts` `coerce.to_externref` case), resolving it via
`resolveString()`/the operand valtype — precisely where the issue wants mode
resolved. `from-ast.ts:coerceYieldValueToExternref` now emits the abstract
coerce **unconditionally** (one `nativeStrings` read removed); the lowerer
elides the convert in host mode and emits it in native mode.

- **Byte-inert proof**: identical compiled binaries (sha256) in BOTH modes
  before/after, over the IR string-iteration + generator-for-of corpus.
  Elision is dead for existing callers (from-ast guarded every site), so no
  other `coerce.to_externref` site changes.
- **Validation**: `issue-1374-ir-string-iter-inline`, `issue-1665-standalone-
  generator-forof` (native-strings `(ref $AnyString)`→convert_any path),
  `ir-frontend-widening`, `issue-1470-string-iteration-standalone`,
  `issue-2157`/`2162` iterators — 63 tests green.

### Remaining (slices 2–5)

Sites 2792 / 2912 / 3142 / 3603 each need their own slice with real work
beyond a mechanical move (capability-model integration for the demote/claim
sites; native number-format + native string-method feature reach; relocating
the method-dispatch table and the for-of strategy builders). This is why the
issue as a whole is `reasoning_effort: high`, not a uniform refactor. `status`
stays `ready` — Slice 1 removes one of the five reads and establishes the
lower-time-resolution pattern the rest follow.
