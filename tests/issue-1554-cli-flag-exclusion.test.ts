import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Issue #1554 — --standalone and --allow-fs are logically mutually exclusive
// (--standalone refuses all JS-host imports; --allow-fs enables node:fs JS-host
// imports). The CLI must reject the combination at parse time.

function runCli(extraArgs: string): { stdout: string; stderr: string; status: number } {
  const dir = mkdtempSync(path.join(tmpdir(), "issue-1554-cli-"));
  const inFile = path.join(dir, "input.ts");
  writeFileSync(inFile, `export function test(): number { return 42; }`);
  const cmd = `npx -y tsx ${JSON.stringify(path.resolve("src/cli.ts"))} ${JSON.stringify(inFile)} -o ${JSON.stringify(dir)} --no-dts --quiet ${extraArgs}`;
  try {
    const stdout = execSync(cmd, { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] }).toString();
    return { stdout, stderr: "", status: 0 };
  } catch (e) {
    const err = e as { stdout?: Buffer; stderr?: Buffer; status?: number };
    return {
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
      status: err.status ?? 1,
    };
  }
}

describe("issue #1554 — --standalone and --allow-fs are mutually exclusive", () => {
  it("rejects --standalone --allow-fs with exit 1 and clear error", () => {
    const { stderr, status } = runCli("--standalone --allow-fs");
    expect(status).toBe(1);
    expect(stderr).toMatch(/--standalone and --allow-fs are mutually exclusive/);
  });

  it("rejects --target standalone --allow-fs (long form) the same way", () => {
    const { stderr, status } = runCli("--target standalone --allow-fs");
    expect(status).toBe(1);
    expect(stderr).toMatch(/--standalone and --allow-fs are mutually exclusive/);
  });

  it("accepts --standalone alone", () => {
    const { status } = runCli("--standalone");
    expect(status).toBe(0);
  });

  it("accepts --allow-fs alone (default gc target)", () => {
    const { status } = runCli("--allow-fs");
    expect(status).toBe(0);
  });
});
