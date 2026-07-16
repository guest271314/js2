import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyPullRequest,
  planPullRequestAction,
  readPullRequest,
  readPullRequestForBranch,
  scopePullRequestIssues,
} from "../scripts/symphony-pr-state.mjs";

describe("Symphony pull-request reconciliation", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("classifies merged and failed pull requests", () => {
    expect(
      classifyPullRequest({
        number: 42,
        state: "MERGED",
        mergedAt: "2026-07-16T08:00:00Z",
        headRefName: "symphony/42",
        headRefOid: "abc123",
        statusCheckRollup: [],
      }),
    ).toMatchObject({ status: "merged", headBranch: "symphony/42", headSha: "abc123" });

    expect(
      classifyPullRequest({
        number: 43,
        state: "OPEN",
        headRefOid: "def456",
        statusCheckRollup: [
          { name: "quality", status: "COMPLETED", conclusion: "FAILURE" },
          { context: "cla-check", state: "SUCCESS" },
        ],
      }),
    ).toMatchObject({ status: "failed", headSha: "def456", failedChecks: ["quality"] });
  });

  it("distinguishes pending checks from a passing rollup", () => {
    expect(
      classifyPullRequest({
        state: "OPEN",
        statusCheckRollup: [{ name: "quality", status: "IN_PROGRESS", conclusion: null }],
      }).status,
    ).toBe("pending");
    expect(
      classifyPullRequest({
        state: "OPEN",
        statusCheckRollup: [
          { name: "quality", status: "COMPLETED", conclusion: "SUCCESS" },
          { name: "optional", status: "COMPLETED", conclusion: "SKIPPED" },
        ],
      }).status,
    ).toBe("passed");
  });

  it("can scope pull-request reconciliation to the selected sprint", () => {
    const issues = [
      {
        id: 1,
        sprint: "porffor-backend",
        selected_sprint: "porffor-backend",
        blocked_by: [{ id: 3 }],
      },
      { id: 2, sprint: "current", selected_sprint: "porffor-backend" },
      { id: 3, sprint: "current", selected_sprint: "porffor-backend", blocked_by: [{ id: 4 }] },
      { id: 4, sprint: "foundation", selected_sprint: "porffor-backend" },
    ];

    expect(scopePullRequestIssues(issues, { sprintOnly: true }).map((issue) => issue.id)).toEqual([1]);
    expect(
      scopePullRequestIssues(issues, { sprintOnly: true, includeDependencies: true }).map((issue) => issue.id),
    ).toEqual([1, 3, 4]);
    expect(scopePullRequestIssues(issues).map((issue) => issue.id)).toEqual([1, 2, 3, 4]);
  });

  it("requeues one failed head once and closes merged work", () => {
    const failed = classifyPullRequest({
      number: 44,
      state: "OPEN",
      headRefOid: "failed-sha",
      statusCheckRollup: [{ name: "quality", conclusion: "FAILURE" }],
    });
    expect(planPullRequestAction(failed)).toEqual({ action: "requeue", failureKey: "failed-sha" });
    expect(planPullRequestAction(failed, { handledFailureKey: "failed-sha" })).toEqual({
      action: "wait",
      failureKey: "failed-sha",
    });
    expect(planPullRequestAction(failed, { busy: true })).toEqual({
      action: "defer",
      failureKey: "failed-sha",
    });
    expect(planPullRequestAction(classifyPullRequest({ state: "MERGED" }))).toEqual({
      action: "mark_done",
      failureKey: null,
      mergeKey: null,
    });
    expect(
      planPullRequestAction(classifyPullRequest({ number: 45, state: "MERGED" }), {
        issueState: "in-progress",
      }),
    ).toEqual({ action: "continue", failureKey: null, mergeKey: "45" });
    expect(
      planPullRequestAction(classifyPullRequest({ number: 45, state: "MERGED" }), {
        issueState: "in-progress",
        lastMergedPr: 45,
      }),
    ).toEqual({ action: "wait", failureKey: null, mergeKey: "45" });
  });

  it("queries gh with the configured repository and classifies its response", () => {
    tempDir = mkdtempSync(join(tmpdir(), "symphony-pr-"));
    const fakeGh = join(tempDir, "gh");
    writeFileSync(
      fakeGh,
      `#!/bin/sh
case "$*" in
  *"pr view 99"*"--repo loopdive/js2"*)
    printf '%s\\n' '{"number":99,"state":"OPEN","url":"https://example.test/99","headRefName":"agent/99","headRefOid":"sha99","statusCheckRollup":[{"name":"quality","status":"COMPLETED","conclusion":"TIMED_OUT"}]}'
    ;;
  *) exit 64 ;;
esac
`,
    );
    chmodSync(fakeGh, 0o755);

    expect(readPullRequest({ command: fakeGh, cwd: tempDir, number: 99, repository: "loopdive/js2" })).toMatchObject({
      number: 99,
      status: "failed",
      headBranch: "agent/99",
      headSha: "sha99",
      failedChecks: ["quality"],
    });
  });

  it("discovers an agent PR from its assigned branch", () => {
    tempDir = mkdtempSync(join(tmpdir(), "symphony-pr-branch-"));
    const fakeGh = join(tempDir, "gh");
    writeFileSync(
      fakeGh,
      `#!/bin/sh
case "$*" in
  *"pr list --head agent/100"*"--repo loopdive/js2"*)
    printf '%s\\n' '[{"number":100,"state":"OPEN","headRefName":"agent/100","headRefOid":"sha100","statusCheckRollup":[]}]'
    ;;
  *) exit 64 ;;
esac
`,
    );
    chmodSync(fakeGh, 0o755);

    expect(
      readPullRequestForBranch({
        branch: "agent/100",
        command: fakeGh,
        cwd: tempDir,
        repository: "loopdive/js2",
      }),
    ).toMatchObject({ number: 100, status: "pending", headBranch: "agent/100" });
  });

  it("persists one repair per failed SHA, continues a merged slice, and marks the final merge done", () => {
    tempDir = mkdtempSync(join(tmpdir(), "symphony-reconcile-"));
    const issuesDir = join(tempDir, "issues");
    const workspaceRoot = join(tempDir, "workspaces");
    const loggingRoot = join(tempDir, "logs");
    const issueFile = join(issuesDir, "9001-pr-retry.md");
    const workflow = join(tempDir, "WORKFLOW.md");
    const fakeGh = join(tempDir, "gh");
    const fakeAgent = join(tempDir, "agent");
    const response = join(tempDir, "pr.json");
    const marker = join(tempDir, "agent-runs.txt");

    mkdirSync(issuesDir, { recursive: true });
    writeFileSync(
      issueFile,
      `---
id: 9001
title: "PR retry probe"
status: in-review
sprint: probe
branch: agent/9001
---
# PR retry probe
`,
    );
    writeFileSync(
      workflow,
      `---
tracker:
  kind: markdown
  issues_dir: ${issuesDir}
  sprint: probe
  active_states: [ready, in-progress, in-review]
  claimable_states: [ready]
  claim_state: in-progress
  terminal_states: [done, wont-fix]
polling:
  interval_ms: 10
pull_requests:
  enabled: true
  repository: loopdive/js2
  command: ${fakeGh}
  poll_interval_ms: 10
  review_states: [in-review, in-progress]
workspace:
  kind: directory
  root: ${workspaceRoot}
agent:
  max_concurrent_agents: 1
  max_turns: 1
  lanes:
    - name: fake-agent
      kind: generic
      command: ${fakeAgent}
      prompt_mode: stdin
      max_concurrent: 1
logging:
  root: ${loggingRoot}
---
Issue {{ issue.identifier }} attempt {{ attempt }}
`,
    );
    writeFileSync(
      fakeGh,
      `#!/bin/sh
if [ "$2" = "list" ]; then
  printf '['
  cat "$PR_RESPONSE"
  printf ']\\n'
else
  cat "$PR_RESPONSE"
fi
`,
    );
    writeFileSync(fakeAgent, `#!/bin/sh\nprintf 'run\\n' >> "$AGENT_MARKER"\ncat >/dev/null\n`);
    chmodSync(fakeGh, 0o755);
    chmodSync(fakeAgent, 0o755);

    const runSymphony = () =>
      execFileSync(process.execPath, ["scripts/symphony.mjs", "--workflow", workflow, "--once"], {
        cwd: process.cwd(),
        env: { ...process.env, PR_RESPONSE: response, AGENT_MARKER: marker },
        stdio: "pipe",
      });

    writeFileSync(
      response,
      JSON.stringify({
        number: 99,
        state: "OPEN",
        headRefName: "agent/9001",
        headRefOid: "failed-sha",
        statusCheckRollup: [{ name: "quality", status: "COMPLETED", conclusion: "FAILURE" }],
      }),
    );
    runSymphony();
    const failedIssue = readFileSync(issueFile, "utf8");
    expect(failedIssue).toContain("pr: 99");
    expect(failedIssue).toContain("last_ci_retry_head: failed-sha");
    expect(failedIssue).toContain("branch: agent/9001");
    expect(readFileSync(marker, "utf8")).toBe("run\n");

    runSymphony();
    expect(readFileSync(marker, "utf8")).toBe("run\n");

    writeFileSync(
      response,
      JSON.stringify({
        number: 99,
        state: "MERGED",
        mergedAt: "2026-07-16T09:00:00Z",
        headRefName: "agent/9001",
        headRefOid: "fixed-sha",
        statusCheckRollup: [],
      }),
    );
    runSymphony();
    const continuedIssue = readFileSync(issueFile, "utf8");
    expect(continuedIssue).toContain("status: in-progress");
    expect(continuedIssue).toContain("pr: null");
    expect(continuedIssue).toContain("last_ci_retry_head: null");
    expect(continuedIssue).toContain("last_merged_pr: 99");
    expect(readFileSync(marker, "utf8")).toBe("run\nrun\n");

    writeFileSync(
      issueFile,
      continuedIssue.replace("status: in-progress", "status: in-review").replace("pr: null", "pr: 100"),
    );
    writeFileSync(
      response,
      JSON.stringify({
        number: 100,
        state: "MERGED",
        mergedAt: "2026-07-16T10:00:00Z",
        headRefName: "agent/9001",
        headRefOid: "final-sha",
        statusCheckRollup: [],
      }),
    );
    runSymphony();
    const mergedIssue = readFileSync(issueFile, "utf8");
    expect(mergedIssue).toContain("status: done");
    expect(mergedIssue).toContain("completed: 2026-07-16");
    expect(readFileSync(marker, "utf8")).toBe("run\nrun\n");
  });
});
