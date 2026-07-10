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
sites; those ops are already abstract elsewhere). Each read is a _different
kind_ of polymorphism, with a different byte-inert path to lower time:

| site     | function                          | polymorphism kind                                                                             | de-polymorph blocker                                                                                                                                                                                                   |
| -------- | --------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~2792    | `coerceToExpectedExtern`          | string→externref host-call arg coercion; **native throws (demote)**                           | native string CANNOT flow into a host-string externref position, so the throw is a **claim/demote decision** — must move to `select.ts` capability (#2135), not lower time. Not byte-inert as a plain "always coerce". |
| ~2912    | number `.toString()` host import  | claims `f64.toString()` **only in host mode**                                                 | native has no native number formatter yet; the mode read is a real capability gate. Needs native number-format feature before it can move.                                                                             |
| ~3142    | `lowerStringMethodCall`           | helper name `__str_X` vs `string_X` + i32/f64 arg reps + native-mode bails + sentinel padding | large mode-specific decision table; a faithful move relocates the whole table (incl. #2002/#1248 special-cases) to `lower.ts`. Own slice.                                                                              |
| **3467** | **`coerceYieldValueToExternref`** | **string→externref coercion for generator-yield / iter-host**                                 | **NONE — cleanly byte-inert. DONE in Slice 1.**                                                                                                                                                                        |
| ~3603    | `lowerForOfStatement` string arm  | native char-loop vs iter-host for-of strategy                                                 | both strategies are big loop builders living in from-ast; moving the _selection_ to lower time means the lowerer owns both loop builders. Own slice.                                                                   |

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

## Re-measured decomposition (2026-07-06, senior-dev, opus-2955)

Measured against `upstream/main` @ `07ad889185`. The Slice-1 table above has
**drifted** — there are now **7 functional `nativeStrings` reads** in
`from-ast.ts` (grep `cx.resolver?.nativeStrings?.()` → lines 3233, 3245, 3402,
3641, 4018, 4124, 5815), and reading each one shows they are **not one
problem**. They split into two distinct classes the original Approach section
conflated. This is the corrected map for whoever picks up slices 2+.

| line | function                              | class                                  | what the read gates                                                                                                                                               | why it's not a byte-inert one-liner                                                                                                                                                                                         |
| ---- | ------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3233 | `coerceToExpectedExtern`              | **string-rep**                         | host-mode string is already externref → return as-is; native string (`(ref $AnyString)`) CANNOT flow into an externref host-arg → falls to the throw (**demote**) | the guard is load-bearing for the native demote; de-polymorph = capability decision → move to `select.ts` (#2135), not lower time                                                                                           |
| 3245 | `coerceToExpectedExtern`              | **number-box capability** (NOT string) | f64→externref via `__box_number`, **host lane only**; standalone has no `__box_number` (boxes via `$AnyValue`) → demote                                           | `nativeStrings === false` is a **proxy for "JS-host lane has the box helpers"**. De-polymorph = route through a capability query + emit `$AnyValue` boxing in standalone; touches number-boxing → **standalone-floor risk** |
| 3402 | string→externref coercion arm         | string-rep                             | same host-externref rep assumption                                                                                                                                | abstract-op introduction                                                                                                                                                                                                    |
| 3641 | `lowerStringMethodCall` (`useNative`) | **string-rep, largest**                | `__str_<m>` native helper vs `string_<m>` host import + i32/f64 arg reps + native bails + sentinel padding (#2002/#1248)                                          | relocates the **entire mode-specific dispatch table** to `lower.ts`. Own slice, biggest.                                                                                                                                    |
| 4018 | `coerceReturnValue`                   | **number-box capability** (NOT string) | externref→f64 via `__unbox_number`, **host lane only**; standalone demotes                                                                                        | same proxy as 3245; mirror slice (box + unbox move together)                                                                                                                                                                |
| 4124 | string arm                            | string-rep                             | host-mode string rep                                                                                                                                              | abstract-op introduction                                                                                                                                                                                                    |
| 5815 | undefined-test on operand             | string-rep                             | host-mode string is externref-shaped → `__extern_is_undefined`; native rep takes the fold path below                                                              | needs an abstract "is-undefined-on-string" IR op that resolves rep at lower time; not a plain guard removal                                                                                                                 |

**Key correction for the next picker:** sites **3245 and 4018 are not string
polymorphism at all** — they read `nativeStrings === false` only as a stand-in
for "are we in the JS-host lane that owns `__box_number`/`__unbox_number`?". The
clean fix for those two is a **capability predicate** (e.g.
`resolver.hasHostNumberBox?()`), moved together as one mirror slice, and
validated against the **standalone floor** (not just equivalence) because the
standalone demote arm is load-bearing. They arguably belong in a separate
capability-model issue rather than being counted against #2955's string
de-polymorph.

**Recommended slice order (each its own PR):**

- **Slice 2 — number-box capability (3245 + 4018 together).** Introduce a
  `resolver.hasHostNumberBox()` capability; from-ast emits an abstract
  `coerce.f64↔externref` box/unbox op unconditionally; `lower.ts` resolves
  host-box vs standalone-`$AnyValue`-box vs demote. Byte-inert per mode.
  **Must validate the standalone floor** (`merge_group`), not just equivalence.
- **Slice 3 — string-rep coercion sites (3233 + 3402 + 4124).** Following the
  Slice-1 pattern: abstract string→externref coerce op, lower-time rep
  resolution; the native demote decision moves to `select.ts` capability
  (#2135 coordination). Byte-inert per mode.
- **Slice 4 — undefined-test on string (5815).** New abstract
  "is-undefined-on-string" IR op; lowerer picks `__extern_is_undefined` (host,
  externref-shaped) vs the native fold path.
- **Slice 5 — `lowerStringMethodCall` dispatch table (3641).** Largest;
  relocate the whole `__str_<m>`/`string_<m>` decision table (incl. #2002/#1248
  arg-rep + sentinel special-cases) to `lower.ts`. Own slice, do last.

**Why no code slice landed this pass (senior-dev, final-budget):** every
remaining site requires either an abstract-IR-op introduction (op-union +
verifier signature + `lower.ts` case + per-mode byte-identity proof over a
string corpus) or a new capability predicate touching the standalone floor —
none is a sub-25-min byte-inert land like Slice 1 was (Slice 1 exploited an
already-abstract `coerce.to_externref` op whose new elision arm was dead for
all existing callers). Banking this corrected map instead of sinking final
budget into a half-finished op introduction. `status` stays `ready`.

## Number-box capability slice (2026-07-10, fable-10th) — sites 3245+4018 (map lines) → `hasHostNumberBox`

The two **number-box** reads (the re-measured map's "NOT string polymorphism"
pair) are relocated: `coerceToExpectedExtern`'s f64→externref `__box_number`
arm and `coerceReturnValue`'s externref→f64 `__unbox_number` arm no longer
read `nativeStrings?.() === false` — they consult a resolver-owned capability
predicate, `IrFromAstResolver.hasHostNumberBox()`, implemented in
`integration.ts` (`makeFromAstResolver`) as exactly `!ctx.nativeStrings`.
Byte-inert relocation: the predicate's truth table is identical to the old
in-place proxy reads in both modes (including the resolver-absent case:
`undefined === false` and `undefined === true` are both false → demote).

Two constraints recorded for whoever widens this later (per the Slice-2
pattern discussion with fable-2856):

- **The capability answer must stay a build-time answer** — the demote arm
  (the `coerceToExpectedExtern` throw / the #1798-gate slip in
  `coerceReturnValue`) is a claim/demote decision and there is no lower-time
  demote channel. Same constraint as the Slice-2 `stringMethodPlan` callback;
  this predicate is the boolean sibling of that lower-time-owned query shape
  (a full plan-object wasn't needed — the arm bodies are mode-invariant, only
  availability varies).
- **Widening is a semantic follow-up, not this slice**: allowing the box pair
  under a native-strings HOST compile, or lowering to `$AnyValue` boxing in
  standalone instead of demoting, changes claim behavior and **must be
  validated against the standalone floor** (`merge_group`), because the
  standalone demote arm is load-bearing.

**Verification**: sha256-identical compiled binaries vs pristine base in BOTH
modes over a 17-source corpus (14 playground examples + targeted box/unbox +
string-iter snippets): host `b246b07133d1be80`, native `097a7d8abc01e23a`,
12 compiled / 2 pre-existing CEs per mode, unchanged. `tsc --noEmit` clean;
prettier clean; `issue-2856-extern-in-ir` + `issue-2856-vec-push` +
`ir-frontend-widening` 39/39; `ir-algorithms-cluster` (covers the
`coerceReturnValue` unbox arm) 18/18.

**Remaining after this slice** (from-ast functional `nativeStrings` reads):
the string-rep coercion/demote class (`coerceToExpectedExtern` string arm +
the string→externref arm + the undefined-test at the map's 5815), the
number-`toString` capability site (string-rep-coupled: the host import's
return IS host-mode's string carrier), `lowerStringMethodCall` (Slice 2, PR
#2857 in flight), and the for-of strategy switch. `status` stays `ready`.
