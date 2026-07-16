import { spawnSync } from "node:child_process";

const FAILED_CONCLUSIONS = new Set(["ACTION_REQUIRED", "CANCELLED", "FAILURE", "STARTUP_FAILURE", "TIMED_OUT"]);
const PENDING_STATUSES = new Set(["IN_PROGRESS", "PENDING", "QUEUED", "REQUESTED", "WAITING"]);

function checkName(check) {
  return String(check?.name ?? check?.context ?? "unknown check");
}

function checkConclusion(check) {
  return String(check?.conclusion ?? check?.state ?? "").toUpperCase();
}

function checkStatus(check) {
  return String(check?.status ?? "").toUpperCase();
}

function normalizePullRequestNumber(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  const match = text.match(/\/pull\/(\d+)/i) || text.match(/^#?(\d+)$/);
  return match ? match[1] : text;
}

function selectPullRequestForBranch(snapshots, { excludeNumbers = [] } = {}) {
  const excluded = new Set(excludeNumbers.map(normalizePullRequestNumber).filter(Boolean));
  const candidates = snapshots.filter((snapshot) => {
    const number = normalizePullRequestNumber(snapshot?.number);
    return !number || !excluded.has(number);
  });
  return candidates.find((snapshot) => String(snapshot?.state ?? "").toUpperCase() === "OPEN") ?? candidates[0] ?? null;
}

export function classifyPullRequest(snapshot) {
  if (!snapshot || typeof snapshot !== "object") throw new Error("invalid_pull_request_snapshot");

  const state = String(snapshot.state ?? "").toUpperCase();
  const headSha = snapshot.headRefOid ? String(snapshot.headRefOid) : null;
  const base = {
    number: Number(snapshot.number) || null,
    url: snapshot.url ? String(snapshot.url) : null,
    headBranch: snapshot.headRefName ? String(snapshot.headRefName) : null,
    headSha,
  };

  if (state === "MERGED" || snapshot.mergedAt) {
    return {
      ...base,
      status: "merged",
      mergedAt: snapshot.mergedAt ? String(snapshot.mergedAt) : null,
      failedChecks: [],
    };
  }

  const checks = Array.isArray(snapshot.statusCheckRollup) ? snapshot.statusCheckRollup : [];
  const failedChecks = checks.filter((check) => FAILED_CONCLUSIONS.has(checkConclusion(check))).map(checkName);
  if (failedChecks.length > 0) return { ...base, status: "failed", mergedAt: null, failedChecks };

  if (state === "CLOSED") return { ...base, status: "closed", mergedAt: null, failedChecks: [] };

  const pending =
    checks.length === 0 ||
    checks.some((check) => {
      const conclusion = checkConclusion(check);
      return !conclusion || PENDING_STATUSES.has(checkStatus(check));
    });
  return { ...base, status: pending ? "pending" : "passed", mergedAt: null, failedChecks: [] };
}

export function planPullRequestAction(
  state,
  {
    handledFailureKey = null,
    issueState = "in-review",
    lastMergedPr = null,
    busy = false,
    paused = false,
    hasCapacity = true,
  } = {},
) {
  if (state.status === "merged") {
    if (issueState === "in-progress") {
      const mergeKey = state.number ? String(state.number) : state.headSha || "unknown-merge";
      return {
        action: String(lastMergedPr || "") === mergeKey ? "wait" : "continue",
        failureKey: null,
        mergeKey,
      };
    }
    return { action: "mark_done", failureKey: null, mergeKey: null };
  }
  if (state.status !== "failed") return { action: "wait", failureKey: null };

  const failureKey = state.headSha || `pr-${state.number || "unknown"}-unknown-head`;
  if (handledFailureKey === failureKey) return { action: "wait", failureKey };
  if (busy || paused || !hasCapacity) return { action: "defer", failureKey };
  return { action: "requeue", failureKey };
}

export function scopeSprintIssues(issues, { includeDependencies = false } = {}) {
  const byId = new Map(issues.map((issue) => [String(issue.id), issue]));
  const selected = issues.filter((issue) => String(issue.sprint) === String(issue.selected_sprint));
  if (!includeDependencies) return selected;

  const included = new Set(selected.map((issue) => String(issue.id)));
  const queue = [...selected];
  for (let index = 0; index < queue.length; index++) {
    const issue = queue[index];
    for (const dependency of issue.blocked_by ?? []) {
      const dependencyId = String(dependency?.id ?? dependency?.identifier ?? dependency);
      const dependencyIssue = byId.get(dependencyId);
      if (!dependencyIssue || included.has(dependencyId)) continue;
      included.add(dependencyId);
      queue.push(dependencyIssue);
    }
  }
  return issues.filter((issue) => included.has(String(issue.id)));
}

export function scopePullRequestIssues(issues, { sprintOnly = false, includeDependencies = false } = {}) {
  if (!sprintOnly) return issues;
  return scopeSprintIssues(issues, { includeDependencies });
}

export function readPullRequest({ command = "gh", cwd, number, repository = "", timeoutMs = 30_000 }) {
  const args = [
    "pr",
    "view",
    String(number),
    "--json",
    "number,state,mergedAt,url,headRefName,headRefOid,statusCheckRollup",
  ];
  if (repository) args.push("--repo", repository);

  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`pull_request_query_failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`pull_request_query_failed: ${String(result.stderr || result.stdout || result.status).trim()}`);
  }

  let snapshot;
  try {
    snapshot = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`pull_request_query_invalid_json: ${error.message}`);
  }
  return classifyPullRequest(snapshot);
}

export function readPullRequestForBranch({
  branch,
  command = "gh",
  cwd,
  repository = "",
  timeoutMs = 30_000,
  excludeNumbers = [],
}) {
  const args = [
    "pr",
    "list",
    "--head",
    String(branch),
    "--state",
    "all",
    "--limit",
    "20",
    "--json",
    "number,state,mergedAt,url,headRefName,headRefOid,statusCheckRollup",
  ];
  if (repository) args.push("--repo", repository);

  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw new Error(`pull_request_query_failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`pull_request_query_failed: ${String(result.stderr || result.stdout || result.status).trim()}`);
  }

  let snapshots;
  try {
    snapshots = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`pull_request_query_invalid_json: ${error.message}`);
  }
  if (!Array.isArray(snapshots)) throw new Error("pull_request_query_invalid_json: expected an array");
  const selected = selectPullRequestForBranch(snapshots, { excludeNumbers });
  return selected ? classifyPullRequest(selected) : null;
}
