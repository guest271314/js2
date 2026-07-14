---
name: reference_irfirst_widen_skip_ceiling_28pct_pivot_to_selfhost
description: "The IR-first allowlist SIGNATURE-WIDEN program (f64→bool→native-int, #3203+) caps at a ~28% skip-coverage CEILING — measured empirically 441/1,568 top-level funcs on the tests/equivalence corpus. The other ~72% need G4 runtime-path IR (strings/objects/arrays/methods), NOT reachable by any signature widening. So the first Phase-3b legacy-handler DELETION is 10+ PRs out, gated on the runtime-IR migration (#2856+), not on widening. Do NOT re-attempt 'widen → delete soon'. Pivot spare senior cycles to immediate-−LOC self-host units."
metadata:
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

**Measured 2026-07-13 (opus-delete), empirical on the 1,568 top-level
functions of the tests/equivalence corpus — the decision-gate estimate for the
−60k Phase-3b deletion.**

The #3143 IR-first flip cleared G1 for a NUMERIC-only skip population; the −60k
legacy-frontend deletion was expected to unlock incrementally as the skip
allowlist widens (f64→bool→native-int). This measurement bounds that program:

- **Widen-reachable skip CEILING = 441/1,568 = 28.1%.** These are functions
  whose signature is number/bool/native-int AND whose body is primitive (no
  member access / method calls / `new` / strings / arrays / objects). That is
  the ABSOLUTE MAX skip coverage signature-widening can ever reach, with every
  primitive widen done. Breakdown: num-only=437, +bool=4, **+native-int=0**.
- **needs-runtime = 1,127/1,568 = 71.9%** — need G4 runtime-path IR
  (strings/objects/arrays/methods). NOT reachable by signature widening at all;
  that is the whole IR-full-coverage epic (#2856+ claim-coverage + runtime
  lowering), not a widen.
- **native-i32 adds 0.0% on this corpus** — there are ZERO native-int
  (`i32`/`u32`) annotations in the equivalence corpus. Implementing it is pure
  correctness groundwork (removes the i32/bool domain-ambiguity caveat), NOT a
  coverage lever. Don't spend cycles on it for coverage.
- **identifiers.ts G2 distance:** `Identifier` appears in ~every function, so
  `expressions/identifiers.ts` (and every all-ir-owned file) closes its G2 gate
  only at ~100% skip coverage. The widen caps at 28%. Closing the remaining 72%
  IS the runtime-path migration → **10+ PRs, realistically many more**, not 2-3.

**Decision taken: PIVOT.** Bank the widen (#3203 f64→bool, landed) as correctness
groundwork; move senior cycles to immediate-−LOC self-host units
([[reference_selfhost_netnegative_needs_full_elemkind_dialect]] — timsort −404,
object-runtime −145, Math next). The widen + #2856 body-shape-rejected
bucket-drain (claim-coverage) continue INCREMENTALLY/opportunistically as a slow
background epic, not a near-term −LOC lever. **Do NOT let a future agent
re-frame 'widen the allowlist → delete legacy soon' — the ceiling is 28% and the
first deletion is gated on runtime-IR (#2856+), not widening.** Related:
[[reference_irfirst_flip_meter_false_green_skipped_slot_errors]] (the flip
itself + why allowlist-not-denylist), the #3090 delete-list G2 trap (a kind
being ir-owned does NOT make its legacy handler dead — needs whole-function
claim+skip coverage).
