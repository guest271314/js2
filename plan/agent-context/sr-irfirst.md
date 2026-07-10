# sr-irfirst — context summary (2026-07-02, Fable, #2138)

## What I did
- #2138 IR-first compile-once inversion: my unconditional-hoist Slice 1 was
  superseded mid-flight by a parallel session's flag-conditional Slices 1+2
  (6ac915824); I pivoted per lead direction.
- **Landed PR #2484** (merged): gate 4 — host-node skip exclusion in
  `computeIrFirstSkipSet` (Trap 4, the #2856 sequencing requirement
  "#2138 owner to mirror"). Scan lives in `src/codegen/ir-first-gate.ts`
  (cycle-free module; importing codegen/index.ts from tests trips a
  boolToStringEmitter init cycle). Calibration: allowlists exactly today's
  selector ambient accepts (root `Math`, opaque NewExpression roots); latent
  until #2856's host arms land. 8 unit tests + integration guard in
  tests/issue-2138.test.ts. Also committed scripts/byte-diff-corpus.mts
  (two-checkout byte-identity harness, 2,692-compile validation run was
  0-diff).
- **Open PR #2501** (docs+scripts, CI pending at handoff): claim-rate
  measurement addendum + scripts/ir-first-sweep.mts. Results: skip rate
  14/437 = 3.2% (stride-20 test262 sample; raw files are untyped), −50%
  compile time on claim-dense benchmarks.ts, zero divergences both
  directions. Auto-enqueue owns the merge; if it fails CI someone should
  pick it up (docs-only, low risk).
- Issue #2138 is `status: done` (closed by dev-2138f's full CI run, which
  filed #2972/#2973). Claim lock released (--complete).

## Open threads for next Fable window
- Re-run `scripts/ir-first-sweep.mts` AFTER #2856's HostMemberGet/
  HostMethodCall arms land — gate 4 becomes load-bearing then; skip set must
  stay trap-free while claim rate rises.
- Optional runner extension: record CompileResult.irFirstSkipped into the
  test262 JSONL rows for suite-scale claim-rate tracking.
- #2972 (harness-fn skipped-slot class, #2135 family-2/3) and #2973
  (eval-shim flag inheritance, S) are the remaining flag-on blockers before
  any default-on discussion.
