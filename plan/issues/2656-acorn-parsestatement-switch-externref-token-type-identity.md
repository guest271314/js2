---
id: 2656
title: "++this.field / this.field-- on an any/externref receiver silently drops the write (NaN-fallback) → acorn tokenizer nextToken() never advances (7th dogfood blocker; switch-identity REFUTED)"
status: done
completed: 2026-06-25
assignee: ttraenkler/dev-2046
sprint: 66
created: 2026-06-24
updated: 2026-06-25
priority: high
feasibility: hard
reasoning_effort: high
task_type: bugfix
area: codegen
language_feature: switch
goal: acorn-dogfood
related: [1712, 2608, 2655, 2063]
depends_on: [2655]
origin: "Surfaced by sd-acornloop while root-causing the acorn tokenizer hang (#2655/PR #2038). Masked behind #2655 until that lands; documented as a follow-up note in #2655, promoted here to a tracked issue."
---

# #2656 — acorn `parseStatement` switch on an externref token-type never matches its `tt` singleton

## Problem

This is the **7th acorn-dogfood blocker**, exposed once #2655 (PR #2038) fixes the
tokenizer `this.pos` read/write storage divergence so `parse()` advances past
`readWord1` into `parseStatement`.

In acorn, `parseStatement` does `switch (this.type) { case types._var: … }`, where
`this.type` is a **token-type object** (an externref-typed value) and `types._var`
(`tt._var`) is a **module-level singleton**. The compiled `switch` compares the
externref against the singleton by `===` **reference identity**, and the match
**fails** — no `case` is selected, the default path re-enters, `next()` is never
called, and `parseStatement` loops forever.

Observed (per-process, after #2038, on `parse("var x = 1;")`): `PARSESTMT type=var
pos=3` repeats indefinitely; the token is correctly `var` and `pos` is correct
(so this is *not* #2655 or the #2608 empty-input loop), but the `switch` never
dispatches to the `var` case.

## NOT a duplicate of #2063

#2063 (`switch-strict-equality-violation`, **done**, sprint 61) is the *inverse*
class: it was about **primitive cross-type coercion** in `switch` (`switch(true){case
1:}`, `"1"` matching `case 1:`). This is **object/externref reference identity** —
two references that should be `===` (the token-type value and its singleton) are
not recognized as identical in the compiled `switch` dispatch. Different root
cause, different fix.

## Root cause (to confirm/extend before fixing — verify-first per-process)

The compiled `switch`-on-externref dispatch does not establish reference identity
between the token-type value flowing through the tokenizer and the module-level
`tt.*` singleton it is compared against. Candidate mechanisms (decode the WAT for
the `parseStatement` switch + the `tt._var` singleton construction):
- the token-type singleton is re-materialized (a fresh struct/externref per read)
  instead of canonicalized, so `ref.eq` / `===` is structurally-distinct;
- the `switch` lowers the case comparison via a value/coercion path rather than
  `ref.eq` on the externref;
- a boxing/extern-convert roundtrip on one side breaks identity.

## Acceptance

- `parse("var x = 1;")` dispatches into the `var` case of `parseStatement` and
  returns a `Program` AST (the #1712 differential-AST gate becomes runnable on the
  first fixture).
- A reduced unit repro: a `switch` on an externref whose case is a module-level
  object singleton selects the matching case.
- Full merge_group / test262 (switch-dispatch is a broad-impact path).

## Notes

- Blocked on #2655/PR #2038 landing (the tokenizer must advance to reach
  `parseStatement`). Pick up once #2038 is on main.
- This is the next wall on the acorn dogfood path (#1712); 6 prior blockers
  cleared (#1712 blockers 1-3, #2582, #2608, #2655).

## Investigation 2026-06-25 (dev-2046, verify-first) — REPRO CONFIRMED, hypothesis REFUTED

#2038 merged to main at 12:23. Investigated on top of pull/2038/head (== current
main). Probes used the #1712 JS-host harness (`importObject` + `__setExports` +
`wrapExports`); full-acorn compile is ~130-160s, binary ~693 KB.

**CONFIRMED**: full acorn `parse("var x = 1;")` hangs forever — compiles OK,
instantiates, `parseVar()` never returns within 340s. parseStatement's
`switch(starttype)` never dispatches to `_var`.

**KEY FINDING — the stated root-cause hypothesis (token re-materialization) is
REFUTED.** Direct identity probe in full compiled acorn (tokenize ONE step, then
`this.type === types$1._var` directly, no parse loop):

> `RESULT=111` → identity **HOLDS** (`===` returns true), self-eq holds, labels
> match.

So the tokenized `this.type` IS reference-identical to the `tt` singleton; there
is NO boxing/extern-convert identity break. The three candidate mechanisms in the
Root-cause section above are ruled out for the `===` operator path.

The defect is localized to the **`switch` dispatch lowering** —
`emitSwitchStrictEq`, the strict-per-case externref path in
`src/codegen/statements/control-flow.ts:730` (taken because the `any`/object
discriminant makes `homogeneousSwitchClass` return null). The SAME operand pair
that binary-ops `===` matches as equal is NOT matched by the switch's per-case
comparison → no case selected → default re-enters → loop. i.e. `emitSwitchStrictEq`
diverges from the binary-ops `===` lowering for identical externref operands.

**Could NOT isolate into a fast minimal repro.** Five reductions of escalating
fidelity ALL PASS on current main (seconds to compile): plain class switch; acorn
`this.type` field round-trip through prototype methods; dynamic-index
`keywords[word]` discriminant vs static `types._var` case; full
`Parser`+`finishToken`+`nextToken` chain; that chain + acorn's exact 16-case
fall-through switch (returns 1001 = both direct-=== and switch select `_var`). The
trigger exists only in full acorn and is NOT case count, fall-through, dynamic
reads, or the field round-trip. Prime remaining suspect: a WasmGC type-index /
dedup / singleton-canonicalization effect that only manifests with acorn's
COMPLETE token-type table + full global/type environment — `emitSwitchStrictEq`'s
`ref.test`/`ref.cast` vs `EQ_HEAP` (or the `__host_eq` host bridge) behaving
differently at scale than the binary-ops `===` lowering.

**Switch is NOT broken (proven).** A second full-acorn probe ran the tokenized
`this.type` operand through acorn's EXACT many-case parseStatement switch shape
(`case types$1._var → sw=1`) side-by-side with direct `===`:

> `RESULT=1001` → BOTH the direct `===` AND the switch correctly select the
> `_var` case. `emitSwitchStrictEq` works; the switch-identity premise is dead.

## ROOT CAUSE LOCALIZED 2026-06-25 (dev-2046) — nextToken() call #2 hangs (NOT the switch)

The real hang is in the **tokenizer's successive advance**, before the switch is
even reached on iteration 2. Incremental count probe on full acorn (each
`stepN` does exactly N `nextToken()` calls on `"var x = 1;"` then returns
`pos/end/label`):

> - `step1` (1 call) → `pos=3 end=3 label=var` — CORRECT. First token read fine,
>   `this.pos` advanced 0→3.
> - `step2` (2 calls) → **HANGS**. The SECOND `nextToken()` never returns.

So nextToken() #1 works; nextToken() #2 loops forever internally. parseTopLevel's
`while (this.type !== types$1.eof)` loop never gets a second token, so it spins.
The switch is a red herring — never reached on iteration 2.

**Diagnosis (suspected #2657/#2659-family, same class as #2038's this.pos fix):**
a loop-carried token field has a read/write asymmetry that surfaces only on the
SECOND successive advance. The EXPORT/host read after call 1 sees `pos=3` (the
`__extern_set` sidecar), but call-2's INTERNAL `struct.get` of `this.pos` (in
`readToken`/`skipSpace`/`skipSpaceToken`, the scan-advance condition) almost
certainly reads a STALE value, so the scanner never progresses past position 3 →
infinite scan loop. Either (a) a mutable-dispatch gap on a field other than
#2038's `this.pos`, or (b) #2659's immutable-slot sidecar fall-through freezing a
loop-carried read.

**Pinpoint-the-slot next step**: decode the WAT for `pp.nextToken` /
`pp.readToken` / `skipSpace` and identify which `this.*` slot the scan-advance
condition reads via `struct.get`, then confirm whether that slot is written by a
path that updates only the sidecar (not the struct field) — the #2659 symmetric
struct.set/get dispatch machinery (built by sd-2038) is the fix surface. Likely
fields: `this.pos`, `this.lineStart`, `this.curLine`, `this.lastTokEnd*` —
whichever the call-2 scan loop reads but call-1's write left stale.

**Repro/probe artifacts** (in `probe-2038-acorn` worktree `.tmp/`, gitignored):
`probe2.mts` (full parse hang), `probe-identity.mts` (RESULT=111, `===` identity
holds), `probe-switch.mts` (RESULT=1001, switch works), `probe-eof.mts`
(RESULT=0, no advance to eof), `probe-count.mts` (step1 ok / step2 hangs — the
localization). Full-acorn compile is ~100-180s; the fix loop runs inside it.

NOTE: any struct-dispatch change is SHARED/broad-impact → validate through the
merge_group floor, not a scoped sweep.

## Resolution (2026-06-25, dev-2046)

**Fixed in `src/codegen/expressions/unary-updates.ts` — `compileMemberIncDec`.**

Root cause (pinned via fast isolated repro, ~3s compile): for an `any`/`externref`
receiver (a fnctor-instance `this` inside a prototype method — acorn's tokenizer
shape), `resolveStructName` returns undefined, so `compileMemberIncDec` hit its
`f64.const NaN` graceful fallback and **silently dropped the write**. So
`++this.pos` / `this.pos--` were no-ops. Decoded WAT confirmed: the closure body
was literally `f64.const NaN; drop` — no `f64.add`, no `struct.set`/`__extern_set`.
`this.pos = this.pos + 1` and `this.pos += 1` already worked (compound-assignment
Path B + the #2659 symmetric struct.set dispatch); the `++`/`--` UpdateExpression
path simply never got an externref arm.

**Fix:** new helper `emitExternrefMemberIncDec` mirrors the working `+=`
write-back exactly — read current via `__extern_get`, `__unbox_number`→f64, ±1,
`__box_number`→externref, then write back through the SYMMETRIC
`emitAlternateStructSetDispatch` (#2659) so a typed-WasmGC-struct receiver hits
the same slot the member-READ fast path reads, with `__extern_set` (sidecar) as
the terminal fallback. Prefix returns NEW, postfix returns OLD (§13.4). f64
numeric semantics (no BigInt special-casing — the compound path has none here
either). The statically-resolved-struct fast path is untouched.

This is a GENERAL codegen correctness fix (silent NaN-drop on `++`/`--` of any
any-typed member), not acorn-specific.

**Verification:**
- `tests/issue-2656.test.ts` — 6/6: fnctor `++this.pos` loop terminates
  (acorn skipSpace shape); prefix returns NEW; postfix returns OLD; `--`
  prefix/postfix; repeated `++` accumulates; class-field control still works.
- Fast repro (10 cases incl. `++`/`--`/`-=`-controls): all correct
  (pre-fix: `++`/`--` returned NaN + dropped write; post-fix: correct).
- **End-to-end acorn advance CONFIRMED**: on full compiled acorn (current main),
  `new Parser(...).nextToken(); nextToken()` previously HUNG on the 2nd call
  (frozen `this.pos`); post-fix it returns `pos=5 end=5 label=name` — the
  tokenizer advances across successive `nextToken()` calls. Blocker #7 cleared.

**Residual (SEPARATE, downstream — NOT this issue):** full `parse("var x = 1;")`
still does not return — with the tokenizer now advancing, `parse()` hits a
further, distinct wall deeper in the parser (the natural 8th dogfood blocker).
That is a new root-cause hunt (carve a follow-up issue); it is NOT a regression
of this fix and NOT the `++this.pos` freeze, which is resolved.

**The earlier "switch-on-externref identity" framing was REFUTED** (see
Investigation section above: direct `===` identity holds RESULT=111; the
many-case switch dispatches correctly RESULT=1001). The real cause was the
`++`/`--` write-drop, fixed here.

**Broad-impact change to shared unary-update lowering — validated through the
FULL merge_group / test262 floor (per `project_broad_impact_validate_full_ci`),
not a scoped sweep.** Local adjacent suites: #2659 green (4/4); the
`prefix-postfix-increment-property` / `static-members` / `issue-incremental`
local FAILs are PRE-EXISTING harness-wiring gaps (missing `tests/helpers.ts`,
`result.success` in-process-state sensitivity) identical on clean main, NOT
caused by this change.
