---
name: reference_lower_structurizer_materialized_leak_across_tail_dup_arms
description: "src/ir/lower.ts structurizer soundness bug (#2856/#2977): a non-terminating mid-body `if(cond){effect} rest` makes `rest` a merge block that emitBlockBody TAIL-DUPLICATES into both wasm if-arms; the FUNCTION-GLOBAL `materialized` set leaked the then-arm's lazy `local.tee` of an intra-block multi-use value into the else-arm copy, so the else path read a local it never set → SILENT miscompile (Math.log(2.414) returned log(2)) or '[IR-FIRST] undefined SSA value' throw. Fix: snapshot/restore `materialized` around the br_if arms so each runtime path re-materializes its own intra-block locals."
metadata:
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
---

**Root-caused 2026-07-13 (opus-2856), fixed in PR #2977 (~15 LOC in
src/ir/lower.ts).** Presented as two separate "from-ast overlay" bugs
(#3203 classify + #3204 `let`-after-mid-body-`if`), but the IR was correct —
it's a **structurizer/lowering** bug, not from-ast/select.

**Mechanism:** a non-terminating mid-body `if (cond) { effect } rest` rewrite
makes `rest` a merge block that `emitBlockBody` **tail-duplicates into both wasm
`if` arms**. The **function-global `materialized` set** (tracking which lazy
values have been emitted as a `local.tee`) leaked the THEN-arm's tee of an
intra-block multi-use value into the ELSE-arm copy — so the else path emitted a
`local.get` of a local it never `local.set`, reading unset → **silent 0**
(`Math.log(2.414)` returned `log(2)`!) or the `[IR-FIRST] undefined SSA value`
hard throw. It's a CLAIMED-but-MISCOMPILED correctness bug, NOT a selector
rejection.

**Fix:** snapshot/restore `materialized` around the `br_if` arms so each
separate runtime path re-materializes its own intra-block locals. Any future
structurizer/lowering refactor that tail-duplicates blocks MUST scope
per-arm-materialization state (materialized/emitted-tee sets) to the arm, never
share it function-globally across duplicated paths.

**Two corrections it banked:**
1. Fixing this does NOT reduce the `body-shape-rejected` bucket (stays 14) — the
   14 are cross-module benchmark mains (gated on **#2858** cross-module calls +
   first-class function values) + DOM calendar arms, none the overlay shape. So
   "#2856 = drive body-shape-rejected to zero" is a multi-capability program
   gated on #2858/DOM, NOT this fix. The real value here = correctness +
   **IR-first-skip SAFETY** (prereq for the IR-first-ONLY −60k epic: can't make
   IR-first the sole path while it silently miscompiles this shape).
2. The #3203 shape ALSO trips a SEPARATE pre-existing `inline-small`
   post-inline-verify bug (different pass) — left as a focused follow-up.

Related: [[reference_irfirst_flip_meter_false_green_skipped_slot_errors]],
[[reference_irfirst_widen_skip_ceiling_28pct_pivot_to_selfhost]] (the −60k
IR-first program this safety fix serves).
