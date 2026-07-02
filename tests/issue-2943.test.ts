// #2943 — claim-issue.mjs --allocate open-PR scan hardening.
//
// The old scan fanned out 1+N `gh` calls and swallowed every failure silently,
// so under gh rate-limit contention an in-flight PR's issue file vanished from
// the id universe and --allocate handed out a colliding id (2920 vs PR #2424).
// The scan is now one batched GraphQL query with retries, a REST pagination
// fallback for >100-file PRs, and a LOUD degraded-mode signal. These tests
// drive `--debug-pr-scan` through a PATH-injected fake `gh`.
import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";

const SCRIPT = resolve(__dirname, "..", "scripts", "claim-issue.mjs");

function runWithFakeGh(fakeGhBody: string): { out: string; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "fake-gh-"));
  const gh = join(dir, "gh");
  writeFileSync(gh, `#!/usr/bin/env bash\n${fakeGhBody}\n`);
  chmodSync(gh, 0o755);
  try {
    const out = execFileSync(process.execPath, [SCRIPT, "--debug-pr-scan"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { out, err: "" };
  } catch (e: any) {
    // execFileSync throws on non-zero exit; --debug-pr-scan must exit 0.
    throw new Error(`--debug-pr-scan exited non-zero: ${e.stderr}`);
  }
}

describe("#2943 claim-issue --debug-pr-scan (open-PR id scan)", () => {
  it("collects issue ids from the batched GraphQL query", () => {
    const body = `
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  cat <<'EOF'
{"data":{"repository":{"pullRequests":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[
  {"number":1,"files":{"pageInfo":{"hasNextPage":false},"nodes":[{"path":"plan/issues/9999-foo-bar.md"},{"path":"src/x.ts"}]}},
  {"number":2,"files":{"pageInfo":{"hasNextPage":false},"nodes":[{"path":"README.md"}]}}
]}}}}
EOF
  exit 0
fi
exit 1`;
    const { out } = runWithFakeGh(body);
    const r = JSON.parse(out);
    expect(r.complete).toBe(true);
    expect(r.ids).toEqual([9999]);
  });

  it("falls back to REST pagination for >100-file PRs", () => {
    const body = `
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  cat <<'EOF'
{"data":{"repository":{"pullRequests":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[
  {"number":7,"files":{"pageInfo":{"hasNextPage":true},"nodes":[{"path":"plan/issues/9998-first-page.md"}]}}
]}}}}
EOF
  exit 0
fi
if [ "$1" = "api" ] && [[ "$2" == repos/*/pulls/7/files ]]; then
  printf 'src/a.ts\\nplan/issues/9997-tail-page.md\\n'
  exit 0
fi
exit 1`;
    const { out } = runWithFakeGh(body);
    const r = JSON.parse(out);
    expect(r.complete).toBe(true);
    expect(r.ids).toEqual([9997, 9998]);
  });

  it("returns complete:false (not a silent empty set) when gh fails persistently", () => {
    const { out } = runWithFakeGh("exit 1");
    const r = JSON.parse(out);
    expect(r.complete).toBe(false);
    expect(r.ids).toEqual([]);
  });

  it("retries transient gh failures and succeeds", () => {
    // Fail the first call, succeed afterwards (state via a marker file next to
    // the fake gh binary).
    const body = `
MARK="$(dirname "$0")/.called"
if [ ! -f "$MARK" ]; then
  touch "$MARK"
  exit 1
fi
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  cat <<'EOF'
{"data":{"repository":{"pullRequests":{"pageInfo":{"hasNextPage":false,"endCursor":null},"nodes":[
  {"number":3,"files":{"pageInfo":{"hasNextPage":false},"nodes":[{"path":"plan/issues/9996-retry-win.md"}]}}
]}}}}
EOF
  exit 0
fi
exit 1`;
    const { out } = runWithFakeGh(body);
    const r = JSON.parse(out);
    expect(r.complete).toBe(true);
    expect(r.ids).toEqual([9996]);
  });
});
