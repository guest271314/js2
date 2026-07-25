#!/usr/bin/env node
// auto-park-merge-group-failure.mjs — park a PR that FAILED a required CI
// workflow in the MERGE QUEUE, so the auto-enqueue sweep stops re-adding it.
//
// WHY THIS EXISTS (#2547): test262 now runs only in the merge_group (the #2519
// slim-down), so a PR can be fully green at PR-time yet carry a REAL test262
// regression that only surfaces when the queue validates it on the merged
// state. GitHub ejects the PR from the queue, but `auto-enqueue` sees it is
// still PR-green and re-enqueues it — it cycles forever, burning a ~15-minute
// merge_group CI run every lap. This script breaks that loop: when a required
// workflow concludes `failure` for a `merge_group` event, it parks the
// offending PR by adding the `hold` label (which `enqueue-green-prs.mjs` skips
// via HOLD_LABELS) and posts ONE idempotent comment telling the author to fix
// the failure and remove `hold` to re-enqueue.
//
// CRITICAL — REAL FAILURE vs CANCELLATION (the #1 footgun; see memory
// project_merge_queue_requeue_cancels_run / project_merge_queue_dup_issue_id_churn).
// When the merge queue rebuilds a group (a membership change: main advanced, an
// entry ahead was dequeued, a PR was added/removed) it CANCELS the in-flight
// runs of the old group. GitHub surfaces that cancellation as a RUN-LEVEL
// `failure` conclusion too — but with ZERO failed JOBS (every job is
// `cancelled`/`success`, none `failure`). Parking on those would wrongly hold
// healthy PRs that were merely re-grouped. So we NEVER trust the run-level
// conclusion alone: we fetch the run's jobs and park ONLY when at least one job
// has `conclusion === "failure"` (a genuinely failed shard/check). Zero failed
// jobs ⇒ it was a cancellation ⇒ do nothing.
//
// USAGE
//   node scripts/auto-park-merge-group-failure.mjs <run-id>
//     Reads the run, maps gh-readonly-queue/main/pr-<N>-<sha> -> PR N, checks
//     for a genuinely-failed job, and parks PR N. Requires `gh` authenticated
//     with pull-requests:write, issues:write, actions:read (GITHUB_TOKEN is
//     sufficient — labelling/commenting does not need to trigger a downstream
//     workflow).
//   node scripts/auto-park-merge-group-failure.mjs --self-check
//     Runs the pure-logic unit checks (branch parse + real-vs-cancellation
//     classification) with no network access and exits non-zero on failure.
//   DRY_RUN=1 ... : log the decision without labelling/commenting.

import { execFileSync } from "node:child_process";

const REPO = process.env.GH_REPO || "loopdive/js2";
const DRY = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";
const HOLD_LABEL = "hold"; // matches enqueue-green-prs.mjs HOLD_LABELS
const MARKER = "<!-- auto-park-bot:merge-group-failure -->";

// IMPORTANT: invoke gh via execFileSync with an ARG ARRAY (never a shell
// string) — args bypass the shell so refs/SHAs with special chars are safe.
function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function ghMaybe(args) {
  try {
    return { ok: true, stdout: gh(args), stderr: "" };
  } catch (e) {
    return { ok: false, stdout: String(e.stdout || ""), stderr: String(e.stderr || e.message || e) };
  }
}

// --- pure logic (unit-tested via --self-check) ------------------------------

// Parse a merge-queue ref into its PR number. The merge queue names its
// synthetic branches `gh-readonly-queue/<base>/pr-<N>-<headSha>` (confirmed in
// merge-group-sweeper.yml). Returns the PR number or null
// for any branch that is not a queue ref (we must never park on those).
export function prNumberFromQueueBranch(branch) {
  if (typeof branch !== "string") return null;
  const m = branch.match(/^gh-readonly-queue\/[^/]+\/pr-(\d+)-[0-9a-f]+$/);
  return m ? Number(m[1]) : null;
}

// INFRA steps — a failure HERE says nothing about the merged state's health.
// Motivating incident (2026-07-24): two parks landed the same day with textually
// identical comments ("Failed checks: - check for test262 regressions", no run
// URL, no step name). #3566 was BOGUS — the shard-artifact download 403'd, the
// verdict step never ran, and the PR merged cleanly once unparked. #3563 was
// CORRECT — the verdict ran and caught a real uncatchable-trap regression. Two
// opposite situations, indistinguishable from the comment, each costing a full
// manual investigation.
//
// Patterns are deliberately TIGHT. Widening this list makes the bot park LESS,
// which is the dangerous direction (a real regression slips into main). When in
// doubt, leave a step out so it classifies as non-infra and parks.
// The transfer-verb entries are grounded in the REAL step inventory, harvested
// 2026-07-25 from .github/workflows/test262-sharded.yml — not guessed:
//   "Download shard artifacts"            "Upload shard artifacts"
//   "Download merged reports (…)"         "Upload merged reports"
//   "Download just-landed group artifact" "Upload regressions report"
// Three of those carry no "artifact" token at all, so an artifact-word-only
// pattern would have MISSED the #3566 class. Every `^Download`/`^Upload` step in
// this repo is pure transfer — none computes a verdict. If a verdict step is
// ever named "Download and compare …", this list must be tightened, because
// that is the direction that lets a regression through.
// `tests/issue-3597-auto-park-step-aware.test.ts` pins the real names so a
// workflow rename surfaces here.
export const INFRA_STEP_PATTERNS = [
  /^set up job$/i,
  /^complete job$/i,
  /^post\s/i, // actions' generated post-run steps ("Post Run actions/checkout@v5")
  /^(check ?out)\b/i,
  /^run actions\/(checkout|setup-node|setup-python|setup-java|cache|download-artifact|upload-artifact)\b/i,
  /^set ?up (node|pnpm|python|java|go|ruby)\b/i,
  /^initialize containers$/i,
  /^stop containers$/i,
  /^(download|upload)\s/i, // transfer steps (see inventory above)
  /\b(download|upload)\b[^\n]*\bartifacts?\b/i,
  // Both orders — "Retry shard artifact upload on transient flake (#3404)" puts
  // the noun FIRST, which an artifact-then-download-only pattern missed (caught
  // by the real-step-name cases in tests/issue-3597-auto-park-step-aware.test.ts).
  /\bartifacts?\b[^\n]*\b(download|upload)\b/i,
];

// Is this step name a setup/infra step (as opposed to a verdict step)?
// Unknown / empty names are NOT infra — they must fall through to parking.
export function isInfraStep(name) {
  if (typeof name !== "string") return false;
  const n = name.trim();
  if (!n) return false;
  return INFRA_STEP_PATTERNS.some((re) => re.test(n));
}

// Classify a run from its jobs list.
//
// (1) CANCELLATION vs REAL FAILURE — a merge-group run that the queue CANCELLED
//     (group rebuilt) reports run-level `failure` but has NO job with
//     conclusion === "failure" (jobs are cancelled/success/skipped). A GENUINE
//     failure has >= 1 failed job.
//
// (2) INFRA vs VERDICT (step awareness) — among genuinely-failed jobs, look at
//     which STEP failed. If EVERY failed step across EVERY failed job is a
//     recognised setup/infra step, the verdict never ran and parking would be
//     bogus (the #3566 shape).
//
// CONSERVATIVE BY CONSTRUCTION: we skip parking only on POSITIVE evidence that
// every failure was infra. A failed job whose failing step we cannot identify
// (`steps` absent/empty — e.g. the API response was trimmed) is
// `unclassifiable` and forces a park. Being wrong in the permissive direction
// lets a real regression into main; being wrong in the strict direction costs
// one label removal.
export function classifyRun(jobs) {
  const failed = (jobs || []).filter((j) => j && j.conclusion === "failure");
  const failedJobs = failed.map((j) => j.name);
  const failedDetails = failed.map((j) => ({
    job: j.name,
    url: j.html_url || null,
    failedSteps: (Array.isArray(j.steps) ? j.steps : [])
      .filter((s) => s && s.conclusion === "failure")
      .map((s) => s.name),
  }));
  const realFailure = failed.length > 0;
  const unclassifiable = failedDetails.some((d) => d.failedSteps.length === 0);
  const infraOnly =
    realFailure && !unclassifiable && failedDetails.every((d) => d.failedSteps.every((s) => isInfraStep(s)));
  return {
    realFailure,
    failedJobs,
    failedDetails,
    unclassifiable,
    infraOnly,
    shouldPark: realFailure && !infraOnly,
  };
}

// Render the "Failed checks:" block — job name, the step(s) that actually
// failed, and the job URL. This is the half that turns a park comment from
// "something failed" into an actionable pointer.
export function renderFailureLines(failedDetails) {
  return (failedDetails || [])
    .map((d) => {
      const steps = d.failedSteps.length ? ` — failing step: ${d.failedSteps.join(", ")}` : " — failing step: unknown";
      const url = d.url ? ` ([job log](${d.url}))` : "";
      return `- ${d.job}${steps}${url}`;
    })
    .join("\n");
}

// --- gh-backed actions ------------------------------------------------------

function fetchJobs(runId) {
  // Paginate so a 114-job test262 matrix is fully covered.
  // `steps[]` carries the per-step `conclusion` — that is what makes the
  // infra-vs-verdict call possible (#3597). `html_url` gives the park comment a
  // direct pointer to the failing job log.
  const out = gh([
    "api",
    "--paginate",
    `repos/${REPO}/actions/runs/${runId}/jobs?per_page=100`,
    "--jq",
    ".jobs[] | {name, conclusion, html_url, steps: [(.steps // [])[] | {name, conclusion}]}",
  ]);
  // --jq with --paginate streams one JSON object per line.
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function prHasHoldLabel(prNumber) {
  const res = ghMaybe(["pr", "view", String(prNumber), "--repo", REPO, "--json", "labels", "--jq", "[.labels[].name]"]);
  if (!res.ok) return false;
  try {
    const names = JSON.parse(res.stdout.trim() || "[]").map((n) => String(n).toLowerCase());
    return names.includes(HOLD_LABEL);
  } catch {
    return false;
  }
}

function park(prNumber, failedDetails, runUrl) {
  const failedJobs = failedDetails.map((d) => d.job);
  if (DRY) {
    console.log(`auto-park: DRY RUN — would park #${prNumber} (failed: ${failedJobs.join(", ")})`);
    console.log(renderFailureLines(failedDetails));
    return;
  }
  // Idempotent: if already held, do nothing (avoids re-commenting on requeues).
  if (prHasHoldLabel(prNumber)) {
    console.log(`auto-park: #${prNumber} already has \`${HOLD_LABEL}\` — nothing to do.`);
    return;
  }
  // Add the hold label. REST API (not `gh pr edit --add-label`, which has hit a
  // Projects-classic error on this repo — see memory
  // project_merge_queue_dup_issue_id_churn).
  const label = ghMaybe([
    "api",
    "-X",
    "POST",
    `repos/${REPO}/issues/${prNumber}/labels`,
    "-f",
    `labels[]=${HOLD_LABEL}`,
  ]);
  // Post one idempotent comment, guarded by the HTML marker.
  const body = `${MARKER}
auto-parked: failed required CI in the merge_group — a real test262/quality regression only surfaces on the merged state, so this PR cycles forever in the queue otherwise (#2547). Fix the failure and remove the \`${HOLD_LABEL}\` label to re-enqueue.

Failed checks:
${renderFailureLines(failedDetails)}

Run: ${runUrl}

<sub>The failing STEP is named above (#3597). If it is a setup/infra step rather than a verdict step, the verdict never ran and this park may be spurious — confirm against the run before removing \`${HOLD_LABEL}\`.</sub>`;
  const comment = ghMaybe(["pr", "comment", String(prNumber), "--repo", REPO, "--body", body]);
  console.log(
    `auto-park: parked #${prNumber} (label=${label.ok} comment=${comment.ok}) — failed: ${failedJobs.join(", ")}`,
  );
  if (!label.ok) console.error(`  label error: ${(label.stderr || "").split("\n")[0].slice(0, 160)}`);
  if (!comment.ok) console.error(`  comment error: ${(comment.stderr || "").split("\n")[0].slice(0, 160)}`);
}

// --- self-check (no network) ------------------------------------------------

function selfCheck() {
  let failures = 0;
  const eq = (got, want, label) => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g !== w) {
      console.error(`FAIL ${label}: got ${g}, want ${w}`);
      failures++;
    } else {
      console.log(`ok   ${label}`);
    }
  };

  // Branch parsing.
  eq(prNumberFromQueueBranch("gh-readonly-queue/main/pr-2547-0a1b2c3d4e5f"), 2547, "parse queue ref");
  eq(prNumberFromQueueBranch("gh-readonly-queue/release/pr-12-abcdef0"), 12, "parse non-main base");
  eq(prNumberFromQueueBranch("main"), null, "non-queue branch -> null");
  eq(prNumberFromQueueBranch("issue-2547-foo"), null, "feature branch -> null");
  eq(prNumberFromQueueBranch("gh-readonly-queue/main/pr-xx-abc"), null, "malformed N -> null");
  eq(prNumberFromQueueBranch(undefined), null, "undefined -> null");

  // Real-vs-cancellation classification.
  const pick = (r) => ({
    realFailure: r.realFailure,
    failedJobs: r.failedJobs,
    infraOnly: r.infraOnly,
    unclassifiable: r.unclassifiable,
    shouldPark: r.shouldPark,
  });
  eq(
    pick(
      classifyRun([
        { name: "quality", conclusion: "success" },
        { name: "merge shard reports", conclusion: "failure" },
      ]),
    ),
    {
      realFailure: true,
      failedJobs: ["merge shard reports"],
      infraOnly: false,
      unclassifiable: true,
      shouldPark: true,
    },
    "real failure: one failed job (no steps -> unclassifiable -> park)",
  );
  eq(
    pick(
      classifyRun([
        { name: "quality", conclusion: "cancelled" },
        { name: "test262 shard 1", conclusion: "cancelled" },
        { name: "test262 shard 2", conclusion: "success" },
      ]),
    ),
    { realFailure: false, failedJobs: [], infraOnly: false, unclassifiable: false, shouldPark: false },
    "cancellation: zero failed jobs (queue rebuild) -> do not park",
  );
  eq(
    pick(classifyRun([])),
    { realFailure: false, failedJobs: [], infraOnly: false, unclassifiable: false, shouldPark: false },
    "empty jobs -> do not park",
  );

  // (#3597) Step awareness — the two shapes that were indistinguishable on
  // 2026-07-24.
  eq(isInfraStep("Download shard artifacts"), true, "infra: download shard artifacts");
  eq(isInfraStep("Set up job"), true, "infra: set up job");
  eq(isInfraStep("Checkout"), true, "infra: checkout");
  eq(isInfraStep("Post Checkout"), true, "infra: post-step");
  eq(isInfraStep("check for test262 regressions"), false, "verdict: regression check is NOT infra");
  eq(isInfraStep("Run standalone floor gate"), false, "verdict: floor gate is NOT infra");
  eq(isInfraStep(""), false, "empty step name is NOT infra");
  eq(isInfraStep(undefined), false, "missing step name is NOT infra");

  eq(
    pick(
      classifyRun([
        {
          name: "check for test262 regressions",
          conclusion: "failure",
          steps: [
            { name: "Set up job", conclusion: "success" },
            { name: "Download shard artifacts", conclusion: "failure" },
            { name: "Compare against baseline", conclusion: "skipped" },
          ],
        },
      ]),
    ),
    {
      realFailure: true,
      failedJobs: ["check for test262 regressions"],
      infraOnly: true,
      unclassifiable: false,
      shouldPark: false,
    },
    "#3566 shape: artifact download failed, verdict never ran -> DO NOT park",
  );
  eq(
    pick(
      classifyRun([
        {
          name: "check for test262 regressions",
          conclusion: "failure",
          steps: [
            { name: "Download shard artifacts", conclusion: "success" },
            { name: "Compare against baseline", conclusion: "failure" },
          ],
        },
      ]),
    ),
    {
      realFailure: true,
      failedJobs: ["check for test262 regressions"],
      infraOnly: false,
      unclassifiable: false,
      shouldPark: true,
    },
    "#3563 shape: verdict step failed -> MUST park",
  );
  eq(
    pick(
      classifyRun([
        {
          name: "j1",
          conclusion: "failure",
          steps: [{ name: "Download shard artifacts", conclusion: "failure" }],
        },
        {
          name: "j2",
          conclusion: "failure",
          steps: [{ name: "Compare against baseline", conclusion: "failure" }],
        },
      ]),
    ),
    { realFailure: true, failedJobs: ["j1", "j2"], infraOnly: false, unclassifiable: false, shouldPark: true },
    "mixed infra + verdict -> park (any verdict failure wins)",
  );
  eq(
    pick(
      classifyRun([
        { name: "j1", conclusion: "failure", steps: [{ name: "Download shard artifacts", conclusion: "failure" }] },
        { name: "j2", conclusion: "failure", steps: [] },
      ]),
    ),
    { realFailure: true, failedJobs: ["j1", "j2"], infraOnly: false, unclassifiable: true, shouldPark: true },
    "infra + UNCLASSIFIABLE job -> park conservatively",
  );
  eq(
    renderFailureLines([
      { job: "check for test262 regressions", url: "https://x/job/1", failedSteps: ["Compare against baseline"] },
    ]),
    "- check for test262 regressions — failing step: Compare against baseline ([job log](https://x/job/1))",
    "render: job + step + url",
  );
  eq(
    renderFailureLines([{ job: "quality", url: null, failedSteps: [] }]),
    "- quality — failing step: unknown",
    "render: unknown step, no url",
  );

  if (failures) {
    console.error(`\n${failures} self-check(s) failed`);
    process.exit(1);
  }
  console.log("\nall self-checks passed");
  process.exit(0);
}

// --- entrypoint -------------------------------------------------------------

function isMain() {
  return process.argv[1] && process.argv[1].endsWith("auto-park-merge-group-failure.mjs");
}

if (isMain()) {
  if (process.argv.includes("--self-check")) {
    selfCheck();
  }

  const runId = process.argv.find((a) => /^\d+$/.test(a));
  if (!runId) {
    console.error("usage: auto-park-merge-group-failure.mjs <run-id> [--dry-run]");
    process.exit(2);
  }

  // Resolve the run's head_branch + event so we can map and double-check it was
  // a merge_group run (the workflow already gates on this, but be defensive).
  const runJson = JSON.parse(
    gh(["api", `repos/${REPO}/actions/runs/${runId}`, "--jq", "{head_branch, event, conclusion, name}"]),
  );
  if (runJson.event !== "merge_group") {
    console.log(`auto-park: run ${runId} event=${runJson.event} (not merge_group) — skipping.`);
    process.exit(0);
  }
  const prNumber = prNumberFromQueueBranch(runJson.head_branch);
  if (!prNumber) {
    console.log(`auto-park: run ${runId} head_branch="${runJson.head_branch}" is not a queue ref — skipping.`);
    process.exit(0);
  }

  const jobs = fetchJobs(runId);
  const { realFailure, failedJobs, failedDetails, infraOnly, unclassifiable } = classifyRun(jobs);
  if (!realFailure) {
    console.log(
      `auto-park: run ${runId} (PR #${prNumber}) has 0 failed jobs of ${jobs.length} — CANCELLATION (queue rebuild), NOT parking.`,
    );
    process.exit(0);
  }
  const runUrl = `https://github.com/${REPO}/actions/runs/${runId}`;
  console.log(renderFailureLines(failedDetails));
  if (infraOnly) {
    // (#3597) Every failed step is a recognised setup/infra step, so the verdict
    // never ran — this is the #3566 shape (shard-artifact download 403'd) and a
    // park here would be bogus. The run is still red, so the queue ejects the PR
    // and `auto-enqueue` re-adds it; that retry is the correct response to a
    // transient infra failure.
    console.log(
      `auto-park: run ${runId} (PR #${prNumber}) failed ONLY in setup/infra steps — verdict never ran, NOT parking. See ${runUrl}`,
    );
    process.exit(0);
  }
  console.log(
    `auto-park: run ${runId} (${runJson.name}) for PR #${prNumber} has ${failedJobs.length} genuinely-failed job(s)` +
      `${unclassifiable ? " (at least one failing step unidentifiable — parking conservatively)" : ""} — parking.`,
  );
  park(prNumber, failedDetails, runUrl);
}
