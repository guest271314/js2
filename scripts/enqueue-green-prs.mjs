#!/usr/bin/env node
// enqueue-green-prs.mjs — keep the merge queue fed automatically.
//
// WHY THIS EXISTS: GitHub has no native "auto-enqueue when checks go green".
// The only built-in automation is `gh pr merge --auto`, which arms auto-merge
// on a check-state TRANSITION — it must be armed while checks are still
// pending. But the dev-self-merge gate (net_per_test, regression buckets) needs
// the FINISHED CI results to decide, so by the time an agent acts the PR is
// already CLEAN → no transition left → `--auto` silently no-ops and the PR is
// never queued. The merge queue also DROPS a PR when main advances under it
// (it goes CLEAN-but-dequeued) with nothing re-adding it. Result: green PRs
// strand unqueued (observed repeatedly 2026-05-29). This sweep closes the gap:
// it finds every open, non-draft, mergeable PR that is NOT already in the queue
// and enqueues it via the GraphQL `enqueuePullRequest` mutation.
//
// SAFETY: the merge queue re-runs the REQUIRED checks (cheap gate, merge shard
// reports, quality — incl. the test262 regression gate) on the merged state
// before landing, and GitHub branch protection is the hard block. So enqueuing
// a CLEAN PR cannot land a red PR. Drafts and PRs labelled `hold`/`do-not-merge`
// /`wip` are skipped so work-in-progress is never force-queued.
//
// Runs in GitHub Actions (.github/workflows/auto-enqueue.yml) on CI completion
// + a schedule, and is runnable by hand: `node scripts/enqueue-green-prs.mjs`.
// Requires `gh` authenticated (GITHUB_TOKEN with pull-requests:write in CI).

import { execFileSync } from "node:child_process";

const REPO = process.env.GH_REPO || "loopdive/js2";
const DRY = process.argv.includes("--dry-run");
const HOLD_LABELS = new Set(["hold", "do-not-merge", "do not merge", "wip", "blocked"]);
// mergeStateStatus values we will enqueue. CLEAN = all green. UNSTABLE = mergeable
// but a NON-required check failed (required are green) — still queue-able.
const ENQUEUEABLE = new Set(["CLEAN", "UNSTABLE", "HAS_HOOKS"]);

// IMPORTANT: invoke gh via execFileSync with an ARG ARRAY — never a shell
// string. GraphQL queries contain `$id` and the shell would expand it to
// empty, producing "Expected VAR_SIGN" parse errors. Arrays bypass the shell.
function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function graphql(query, vars = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push("-f", `${k}=${v}`); // -f = raw string field
  return JSON.parse(gh(args));
}

// PR node IDs already in the merge queue → skip.
function queuedNumbers() {
  const r = graphql(
    `{ repository(owner:"${REPO.split("/")[0]}",name:"${REPO.split("/")[1]}"){ mergeQueue(branch:"main"){ entries(first:100){ nodes { pullRequest { number } } } } } }`,
  );
  const nodes = r?.data?.repository?.mergeQueue?.entries?.nodes || [];
  return new Set(nodes.map((n) => n.pullRequest?.number).filter(Boolean));
}

function openPrs() {
  return JSON.parse(
    gh([
      "pr",
      "list",
      "--repo",
      REPO,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,mergeStateStatus,isDraft,labels,id,title",
    ]),
  );
}

const inQueue = queuedNumbers();
const prs = openPrs();
const enqueued = [];
const skipped = [];

for (const pr of prs) {
  const labels = (pr.labels || []).map((l) => (l.name || "").toLowerCase());
  if (pr.isDraft) {
    skipped.push([pr.number, "draft"]);
    continue;
  }
  if (labels.some((l) => HOLD_LABELS.has(l))) {
    skipped.push([pr.number, "hold-label"]);
    continue;
  }
  if (inQueue.has(pr.number)) {
    skipped.push([pr.number, "already-queued"]);
    continue;
  }
  if (!ENQUEUEABLE.has(pr.mergeStateStatus)) {
    skipped.push([pr.number, pr.mergeStateStatus]); // BLOCKED/BEHIND/DIRTY/DRAFT/UNKNOWN
    continue;
  }
  if (DRY) {
    enqueued.push([pr.number, "would-enqueue"]);
    continue;
  }
  try {
    graphql(`mutation($id:ID!){ enqueuePullRequest(input:{pullRequestId:$id}){ clientMutationId } }`, { id: pr.id });
    enqueued.push([pr.number, "enqueued"]);
  } catch (e) {
    // Most common benign error: required checks still in progress (PR just
    // turned mergeable). Leave it — the next sweep / CI-completion run gets it.
    const msg = String(e.stderr || e.message || e).split("\n")[0].slice(0, 120);
    skipped.push([pr.number, `enqueue-failed: ${msg}`]);
  }
}

console.log(`enqueue-green-prs: ${prs.length} open, ${inQueue.size} already queued`);
for (const [n, why] of enqueued) console.log(`  ✓ #${n} ${why}`);
for (const [n, why] of skipped) console.log(`  - #${n} skip (${why})`);
console.log(`Done: ${enqueued.length} ${DRY ? "would be " : ""}enqueued.`);
process.exit(0);
