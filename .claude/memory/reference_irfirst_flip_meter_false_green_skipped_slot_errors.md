---
name: reference_irfirst_flip_meter_false_green_skipped_slot_errors
description: "The #3153 IR post-claim divergence meter (ir-postclaim-meter.mts / check:ir-fallbacks) reads irPostClaimErrors, but the REAL IR-first-flip (#3143) hard errors land in result.errors as '[IR-FIRST skipped-slot]' — the meter is BLIND to them. So a 'meter = ZERO' reading is a FALSE GREEN for flip readiness; scan result.errors instead. This is why every prior #3143 flip attempt regressed in CI despite meter-zero."
metadata:
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

**Diagnosed 2026-07-12 (opus-irflip, completing the #3143 IR-first default
flip).** The prior handoff (fable-eqfix/fable-irflip) claimed "the #3153 meter
STRIDE=300 reads ZERO, classes 1/2/3 gone, only class 4 remains" — a FALSE
GREEN.

**Root cause:** the #3153 divergence meter (`scripts/ir-postclaim-meter.mts`,
`pnpm run check:ir-fallbacks`) reads the `irPostClaimErrors` field. But an
IR-first flip's actual regressions come from **skipped-slot HARD errors** —
functions IR-first tries to own but hard-errors on — which land in
`result.errors` (severity `error`, message `"[IR-FIRST skipped-slot]…"`), NOT
in `irPostClaimErrors`. Proven empirically: the class-4 TA-view-store file
pre-fix returned `errors=2, irPostClaimErrors=0`. So meter-zero ≠ flip-safe.
This is almost certainly **why every prior #3143 flip attempt regressed in CI
despite "meter-zero."**

**The reliable flip-readiness gate:** scan `result.errors` for
`"[IR-FIRST skipped-slot"` across the corpus. Enumerate the COMPLETE
firing-class set and fix the batch; do NOT flip until that scan reads zero.

**CRITICAL corpus-scoping (opus-irflip, 2026-07-12 — the trap that caught two
rounds of "done"):** a file-walking scanner over `examples/`/`playground/`/
`test262/` dirs MISSES the authoritative corpus. The #3153 dense divergence
source is the **inline template-literal programs embedded INSIDE
`tests/equivalence/*.test.ts`** — they are not standalone `.ts` files, so a
dir-walk never sees them. You MUST run the actual equivalence SUITE to hit them
(the CI `equivalence-gate` compares shard partials vs baseline and is what
surfaces these — first-round file-scan "zero" is a FALSE GREEN twice over: once
for reading irPostClaimErrors, once for scanning the wrong corpus). Also run
the cross-backend-parity harness (adversarial WasmGC-vs-linear differential with
its own inline programs — separate again). Real gate classes found beyond the
first three: gate 9 `irFirstBodyMutatesParam` (`n--`/`n+=` on a from-ast
non-slot param), gate 10 `irFirstBodyCallsUnloweredArrayMethod` (selector claims
`recv.m()` without checking m is lowerable — only `.push` on a vec lowers),
`arr.length = 0` "property assignment on ref not in slice 4". All gates are
SAFE-by-construction (compile-twice skip, never a hard error). The from-ast
throw surface is finite (~60 sites, most selector-rejected) and shrinking, but
enumerate against the RIGHT corpora (equivalence-suite inline + cross-backend +
full test262 merge_group) or you get a false green.

**Real blocker classes found (larger than "class 4 only"):**
- class-4 TypedArray-view element store (putAscii/putUint) → fixed via gate 8
  `irFirstBodyStoresTypedArrayView` in `src/codegen/ir-first-gate.ts`
  (compile-twice skip-set, same as gates 4/5/7 — no new lowering).
- `new <TypedArrayCtor>(n)` → "unknown class" (masked by gate 4 in host lane,
  fires standalone).
- `__box_number` "unknown function ref" (e.g. fibMemo): from-ast emits a
  `__box_number` funcref assuming **legacy's `addUnionImports` side-effect**
  registered the import; IR-first skips legacy → import missing. GENERAL fix =
  pre-register the union-import family when the built IR references it
  (idempotent, pre-emission) — NOT per-function gating; likely generalizes to
  other addUnionImports-side-effect-dependent funcrefs.

**STRATEGIC (opus-irflip, 2026-07-12, after scanning the equivalence-inline
corpus): the "flip IR-first → delete −60k in one shot" premise is FALSE — use an
ALLOWLIST, not a denylist.** The full equivalence-inline scan found **~22 real
distinct from-ast throw classes / 125+ skipped-slot hard errors** under
IR-first-default, and they are CORE operations, not edge cases: type-mismatched
arithmetic/compare ("Phase 1 requires matching operand types" — biggest bucket),
most String methods (.split/.replace/.replaceAll/.padStart/.padEnd/.repeat/
.trim*/.lastIndexOf), number .toString/.valueOf on i32/f64, class member
resolution, call/constructor ARITY (default/optional params), property
assignment on ref (obj.prop=/arr.length=), .call/.apply, `new Date`, template/
unary/bool coercion, array-literal widening. **Denylist-gating 22+ core classes
is impractical AND self-defeating** — a gated node kind can't have its legacy
handler deleted (killing the −60k payoff), and any missed shape = a hard-error
regression. **The correct mechanism is an ALLOWLIST:** `computeIrFirstSkipSet`
skips legacy ONLY for functions whose ENTIRE body is a small proven-lowerable
subset (matched-type numeric arith, control flow, local calls with correct
arity, returns — NO method calls / class / closures / coercion / mismatched
types). Safe-by-construction: a missed allowlist entry keeps compile-twice
(safe); a missed denylist entry is a regression. This clears G1 (IR-first is the
default MODE) with a conservative compile-once subset NOW, and the −60k deletion
unlocks **INCREMENTALLY** as the allowlist widens via real lowering
(#2855/#2856) — matching CLAUDE.md's gated G1-G4 deletion model. So #3143's
payoff is a multi-step incremental program, NOT a single flip; the bloat plan's
"flip → −60k now" framing was over-optimistic.

The flip is broad-impact: validate on full-CI/merge_group, net-non-negative,
never force-merge on regression. Related: [[project_broad_impact_validate_full_ci]],
[[feedback_verify_first_beats_architect_spec]] (the deep-tracing dev caught what
the prior devs' meter-trust missed). Issue: #3143; the flip unlocks the ~60k
legacy-frontend deletion (#3090/#2855/#2950).
