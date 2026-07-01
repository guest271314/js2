---
id: 2911
title: "Review: test262 setup + host-vs-standalone classification and pass-rate computation"
status: ready
priority: medium
sprint: current
created: 2026-07-01
feasibility: medium
task_type: review
area: tooling
goal: developer-experience
related: [2910, 2774, 2636, 2097]
---

# #2911 — Review the test262 setup + host/standalone classification & pass rates

**Audit task (execute it — produce findings, don't just fix piecemeal).** Verify
that the test262 pipeline is set up correctly and that tests are classified into
**JS-host** vs **standalone** pass rates accurately and consistently.

## Scope — answer each with evidence
1. **Runner setup.** How test262 runs end-to-end: `pnpm run test:262` /
   `tests/test262-runner.ts` / `scripts/test262-worker.mjs`, the sharded CI
   (`test262-sharded.yml`), worker recycling, skip filters
   (eval/with/Proxy/SharedArrayBuffer/Temporal/…), and how a per-test verdict
   (`pass`/`fail`/`compile_error`/`skip`) is decided. Flag any verdict heuristics
   that can mislabel (e.g. the warning→pass path #2898 hit; the in-process
   batch-scanner cross-test-state false positives; negative/early-error tests).
2. **Host vs standalone modes.** How the SAME test is run in **JS-host** mode
   (host imports) vs **standalone** mode (`--target wasi`/pure-wasm, no JS
   runtime). Where each result is recorded and how the two are kept in sync
   (`build-standalone-cli.mjs`, `build-test262-report.mjs`,
   `test262-standalone-report.json`, `test262-standalone-editions.json`,
   `check-standalone-highwater.mjs`, the #2097 absolute standalone floor).
3. **Classification correctness.** Are tests classified into host/standalone
   pass rates on a sound axis? Is a test that is host-only (uses a host import
   with no standalone fallback) counted correctly in the standalone denominator,
   or does it deflate/inflate the standalone rate? Cross-check against #2910's
   edition/feature classification work — do the standalone editions
   (`test262-standalone-editions.json`) use the same classifier?
4. **Pass-rate math.** Denominators (skip in/out?), dedup (the baseline has
   duplicate records — e.g. `eval-gtbndng-indirect-update-dflt.js` appears
   twice; does that double-count?), and whether host + standalone totals are
   over the same population so they're comparable.
5. **Baseline & staleness.** The committed summary vs the fetched JSONL vs the
   separate `loopdive/js2wasm-baselines` repo; `check-baseline-floor-staleness`;
   how stale the numbers can get and whether the dashboard reflects current main.

## Deliverable
- A written findings section appended to this issue (or a short
  `docs/` note linked here): what's correct, what's wrong/misleading, and
  concrete recommendations.
- File **follow-up issues** (via `claim-issue.mjs --allocate`) for each concrete
  defect found (e.g. double-counting, host-only-in-standalone-denominator,
  classifier divergence), tagged `sprint: current`.
- If a fix is small + safe, it may be done inline; larger fixes → follow-up
  issues routed appropriately.

## Acceptance
- Each scope item (1–5) answered with file:line evidence.
- Any real defect either fixed (small) or filed as a follow-up issue.
- A clear statement of whether the reported host + standalone pass rates are
  trustworthy and comparable, with the caveats enumerated.
