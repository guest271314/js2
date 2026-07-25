# test262 false-positive audit — Fable, 2026-07-25

Requested by the project lead: audit both directions of wrongness in the
conformance number (~30,9k / 43,1k). **False FAIL** = counted failure where
the compiler is right or the harness is broken. **False PASS** = counted
pass that never validated anything (vacuous or coincidental). False PASS is
the more dangerous class — it inflates the headline number and hides real
defects — and is treated as higher severity throughout, even though "false
positive" colloquially usually means the FAIL direction.

Every number below is labeled **[measured]** (I computed/ran it) or
**[estimated]** (extrapolation, sample size stated). Dataset: baseline
JSONL fetched 2026-07-25 (generated 2026-07-24, oracle v10, 47,858 rows =
default scope 43,102 + proposals; pass 30,918 / fail 14,821 / skip 1,331 /
compile_error 653 / compile_timeout 135) [measured]. Sampling seeds: 262
(vacuity probe), 263 (negative sample). Probes ran through the same
`runTest262File` originalHarness path the CI worker mirrors, on an idle-ish
box, with a known-baseline-FAIL control verified first.

## Headline

**The conformance number is largely honest.** The one systemic false-pass
mechanism I found is a real compiler bug (top-level `throw` dropped — #3600)
that happens to have ~zero pass-count impact today but silently defeats
throw-based soundness auditing. The largest quantified false-FAIL bucket is
144 dynamic-import fixture-resolution failures (#3601). The two biggest
_suspected_ buckets going in — #3574 async completion and vacuous passes —
both measured out at (near) zero for the CI baseline.

## Taxonomy

### FALSE PASS direction (more dangerous)

| #   | Class                                                                                                | Count                                                                                                                                                                                                                                                                                                                                   | Basis                                                                                                                                                                                                                                                                                                                        | Severity                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1  | **Top-level unconditional `throw` compiled away** (gc/standalone; #2968 fixed WASI only) → **#3600** | ~0 current passes depend on it [measured: 5/26,336 passing tests have column-0 throws; all 5 conditional on inspection]; ~6 runtime-negative FAILs are victims [measured]                                                                                                                                                               | Root-caused to `src/codegen/declarations.ts` L1522-1524; minimal repro compiles to a module with **no `__module_init` at all**                                                                                                                                                                                               | **High as a bug** (user programs exit 0 instead of throwing; kills throw-probe audits), low as a count                                                         |
| P2  | Vacuous passes (test runs, observes nothing)                                                         | **0/39 in sample** [measured, seed 262]; 95% upper bound ≈ 7.5% (rule of three)                                                                                                                                                                                                                                                         | Injected a _conditional_ `throw new Test262Error(...)` at top of 45 sampled passing tests; 39 control-passed; all 39 flipped to fail with the probe. NOTE: the first probe round used an _unconditional_ throw and reported 43/43 "vacuous" — entirely an artifact of P1. Trust no throw-probe audit run before #3600 lands. | Low — prior work (#2939/#2940/#3086/#3227 S4) already banked the big vacuity classes (e.g. 1,679 rows re-scored by #3227)                                      |
| P3  | Parse/early-negative passes via _unrelated_ rejection                                                | 4,561 parse-negative passes total [measured]; coincidental share ~3-7% ≈ **~150-300** [estimated from 30-file sample, seed 263: 26 construct-specific genuine, 2 probe-flag artifacts (onlyStrict), 1-2 coincidental (e.g. `import.source` rejected as unsupported-proposal where the test expects SyntaxError for a different reason)] | #2912/#2920 already tightened this class hard (dead-ternary fix; compile-succeeded arm strict-fails, −439 false passes). Residual leniency is the documented "any static rejection satisfies SyntaxError" policy                                                                                                             | Low — verdict (reject) is spec-correct today; these flip only if/when the surrounding feature gets implemented, and the ordinary baseline diff will catch that |
| P4  | Passes validated by host `(0, eval)` fallback instead of compiled code                               | 520 passing tests call `eval(` [measured]; host-fallback share 1/7 sampled → **~75** [estimated, wide CI given n=7]                                                                                                                                                                                                                     | Spied `globalThis.eval` during runs: 6/7 eval-calling passes made **zero** host-eval calls (wasm-eval path handled them); 1 (`eval-code/indirect/parse-failure-2.js`) hit the host fallback                                                                                                                                  | Low — bounded, and the wasm-first eval design (#1164) already minimizes it. `host_free_pass` (4,300) separately tracks full host-independence                  |
| P5  | Negative-test passes as share of the headline                                                        | 4,582 of 30,918 passes (14.8%) are negative tests [measured]                                                                                                                                                                                                                                                                            | Structural observation, not a defect: "pass" often means "we rejected the file"                                                                                                                                                                                                                                              | Informational                                                                                                                                                  |

### FALSE FAIL direction

| #   | Class                                                                                                                         | Count                                                                                                                                                                                                                                                                        | Basis                                                                                                                                                                  | Severity                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | **Dynamic-import fixture specifiers resolved against runner cwd** (`Cannot find module .../scripts/*_FIXTURE.js`) → **#3601** | **144** fails [measured]                                                                                                                                                                                                                                                     | Error text embeds the wrong base (`/home/runner/work/js2/js2/scripts/`); root-caused to bare `import(specifier)` in `src/runtime.ts` L13805 with no referrer threading | Highest-value false-FAIL fix; recoverable share ≤144 (unmeasured until fixed)                                                                                                                           |
| F2  | `compile_timeout` limbo rows                                                                                                  | **135** [measured] — but NOT random load flake: 56/135 are one dstr family (`*-ary-init-iter-get-err-array-prototype`), and one member compiles _successfully_ in 11.5 s on a loaded box → deterministic slow compile flapping the 30 s ceiling → **#3602**                  | Filename clustering + timed local compile                                                                                                                              | Medium — baseline-unknown rows (#3595's lens applies; the trap ratchet already excludes them) that flap in diffs and get misread as load noise                                                          |
| F3  | #3574 async completion never observed                                                                                         | **59** rows in the CI baseline [measured] — **the CI lane is fine** (2,735 async passes); sampled rows (2/2) reproduce deterministically and cluster on Promise-rejection paths (`Promise/race` 19, `for-await-of` 9, TLA 5) → genuine machinery gaps, not harness artifacts | Baseline join on `flags: [async]` (5,473 rows) + local reruns                                                                                                          | #3574's "5,616 files" blast radius applies **only to the npm-shipped `js2-test262` CLI / test262.fyi lane**. Measurement + implementation plan appended to #3574                                        |
| F4  | Stale skip filters distorting the denominator                                                                                 | Default-scope skips = **19** + 1 hang [measured]; remaining 1,312 skips are proposal-scoped (Temporal 1,223, import-defer 89) and outside the 43,102 denominator                                                                                                             | JSONL skip-reason histogram                                                                                                                                            | **Stale lead** — the old broad skip list (eval/with/Proxy/…) is gone; every remaining skip carries an owning issue (#1589A, #3122, #1696, #1390). Nothing to fix                                        |
| F5  | Opaque failure rendering `Test262Error: [object Web...`                                                                       | 1,364 async-fail rows share this label [measured]                                                                                                                                                                                                                            | Error-string histogram                                                                                                                                                 | Not false fails (genuine Test262Error assertions) but the message rendering hides the real assertion text — triage friction, noted for whoever owns error rendering (#2962 lineage); no new issue filed |

## Which class is biggest / most dangerous

- **Biggest quantified false-FAIL:** F1 (144, one mechanical fix — #3601),
  then F2's 56-file family (#3602).
- **Most dangerous:** P1/#3600 — not for its count (≈0 today) but because
  it is a silent correctness hole in shipped codegen _and_ it invalidates
  the project's main soundness-auditing technique (throw probes). My own
  first probe round produced a confidently wrong "100% vacuous" result
  because of it; any past throw-probe audit on the gc lane is suspect.
- **Reassuring negatives:** vacuity ≈ 0 in sample; #3574 does not touch the
  CI number; skip-list distortion no longer exists; parse-negative
  leniency is a documented, mostly-genuine 3-7% residue.

## Priority order (filed)

1. **#3600** (high, S) — one-line codegen fix + targeted verification;
   unblocks trustworthy throw-probe audits and flips ~6 fails to passes.
2. **#3601** (medium, M) — 144 false FAILs; thread `importBaseDir` through
   `buildImports` → `dynamic_import` arm; both workers pass `dirname(test)`.
3. **#3602** (medium, M) — profile the dstr family hot spot; 56+ limbo rows
   become honest verdicts and diff noise drops.
4. **#3574** (existing, plan appended) — pursue as a CLI-lane divergence
   bisect (CI worker works, dist worker doesn't), not a Promise-realm hunt.

## Reproduction notes

- Probe scripts live in `.tmp/` (gitignored): `run-vacuity-probe.mts`,
  `neg-sample.mts`, `eval-spy.mts`, `debug-throw*.mts`. Samples:
  `random.seed(262)` over 26,336 non-negative passes (n=45);
  `random.seed(263)` over passing parse/early negatives (n=30).
- Control discipline: a known-baseline-FAIL file
  (`built-ins/Array/from/from-array.js`) was verified to FAIL locally
  before any probe conclusion was drawn; the unconditional-throw round that
  contradicted the control was discarded and re-run conditionally.
