/**
 * #3426 — exact same-SHA JS-host Test262 noise quarantine.
 *
 * These tests execute the real CLI because the base-main workflow consumes its
 * first matching summary lines and exit code, not an internal helper API.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadHostNoiseQuarantine } from "../scripts/diff-test262.js";

interface FixtureRow {
  file: string;
  status: string;
  wasm_sha?: string | null;
  compile_ms?: number;
  error_category?: string;
}

interface ManifestEntry {
  path: string;
  kind: "pass_flip" | "non_pass_status_noise";
}

interface Manifest {
  schema_version: number;
  lane: string;
  provenance: {
    canary_run_id: number;
    compiler_sha: string;
    artifact_id: number;
    compiler_pool_size: number;
  };
  counts: { pass_flips: number; non_pass_status_noise: number; total: number };
  entries: ManifestEntry[];
}

const manifest = JSON.parse(readFileSync("scripts/test262-host-noise-quarantine.json", "utf-8")) as Manifest;
const passFlipPaths = manifest.entries.filter((entry) => entry.kind === "pass_flip").map((entry) => entry.path);

function runDiff(baselineRows: FixtureRow[], candidateRows: FixtureRow[], extraArgs: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "issue-3426-diff-"));
  try {
    const baseline = join(dir, "baseline.jsonl");
    const candidate = join(dir, "candidate.jsonl");
    writeFileSync(baseline, baselineRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    writeFileSync(candidate, candidateRows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", "scripts/diff-test262.ts", baseline, candidate, "--quiet", ...extraArgs],
      { cwd: process.cwd(), encoding: "utf-8" },
    );
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("#3426 — host Test262 same-SHA noise quarantine", () => {
  it("pins the exact audited canary provenance and 360 + 150 path set", () => {
    const loaded = loadHostNoiseQuarantine();
    expect(manifest).toMatchObject({
      schema_version: 1,
      lane: "js-host",
      provenance: {
        canary_run_id: 29632875780,
        compiler_sha: "852c40a9f5167a2a959d53faa066cb0753b623cc",
        artifact_id: 8426392963,
        compiler_pool_size: 4,
      },
      counts: { pass_flips: 360, non_pass_status_noise: 150, total: 510 },
    });
    expect(loaded.paths.size).toBe(510);
    expect(new Set(manifest.entries.map((entry) => entry.path)).size).toBe(510);
  });

  it("passes and fully reports bidirectional churn on canary-known host paths", () => {
    const [regressedPath, improvedPath] = passFlipPaths;
    const result = runDiff(
      [
        { file: regressedPath, status: "pass", wasm_sha: "aaaaaaaaaaaa", compile_ms: 100 },
        { file: improvedPath, status: "fail", wasm_sha: "bbbbbbbbbbbb", compile_ms: 200 },
      ],
      [
        { file: regressedPath, status: "fail", wasm_sha: "cccccccccccc", compile_ms: 110 },
        { file: improvedPath, status: "pass", wasm_sha: "dddddddddddd", compile_ms: 210 },
      ],
    );

    expect(result.status).toBe(0);
    expect(result.output).toContain("Host canary quarantine (#3426): 2 observed transition(s)");
    expect(result.output).toContain(`QUARANTINED ${regressedPath}: pass → fail`);
    expect(result.output).toContain(`QUARANTINED ${improvedPath}: fail → pass`);
    expect(result.output).toContain("Regressions with wasm-hash change: 0");
    expect(result.output).toContain("Improvements (other → pass): 0");
  });

  it("does not let an equal quarantined improvement mask a one-way stable regression", () => {
    const stablePath = "test/built-ins/Array/stable-one-way-regression.js";
    const improvedPath = passFlipPaths[1];
    const result = runDiff(
      [
        { file: stablePath, status: "pass", wasm_sha: "aaaaaaaaaaaa" },
        { file: improvedPath, status: "fail", wasm_sha: "bbbbbbbbbbbb" },
      ],
      [
        { file: stablePath, status: "fail", wasm_sha: "cccccccccccc" },
        { file: improvedPath, status: "pass", wasm_sha: "dddddddddddd" },
      ],
    );

    expect(result.status).toBe(1);
    expect(result.output).toContain("Host stable-path fine-gate net: -1 (0 improvements − 1 regressions)");
    expect(result.output).toContain("GATE FAIL: net_per_test -1 < 0");
  });

  it("keeps a canary-known path strict in the standalone lane", () => {
    const quarantinedPath = passFlipPaths[0];
    const result = runDiff(
      [{ file: quarantinedPath, status: "pass", wasm_sha: "aaaaaaaaaaaa" }],
      [{ file: quarantinedPath, status: "fail", wasm_sha: "bbbbbbbbbbbb" }],
      ["--exclude-leaky-baseline-regressions"],
    );

    expect(result.status).toBe(1);
    expect(result.output).not.toContain("Host canary quarantine (#3426)");
    expect(result.output).toContain("Regressions with wasm-hash change: 1");
  });

  it("never lets the host quarantine weaken the uncatchable-trap ratchet", () => {
    const quarantinedPath = passFlipPaths[0];
    const result = runDiff(
      [{ file: quarantinedPath, status: "pass", wasm_sha: "aaaaaaaaaaaa" }],
      [{ file: quarantinedPath, status: "fail", wasm_sha: "bbbbbbbbbbbb", error_category: "oob" }],
    );

    expect(result.status).toBe(1);
    expect(result.output).toContain(`QUARANTINED ${quarantinedPath}: pass → fail`);
    expect(result.output).toContain('GATE FAIL: trap category "oob" grew 0 → 1 (+1)');
  });

  it("matches exact paths only, never arbitrary lookalikes", () => {
    const arbitraryPath = `${passFlipPaths[0]}.not-in-canary`;
    const result = runDiff(
      [{ file: arbitraryPath, status: "pass", wasm_sha: "aaaaaaaaaaaa" }],
      [{ file: arbitraryPath, status: "fail", wasm_sha: "bbbbbbbbbbbb" }],
    );

    expect(result.status).toBe(1);
    expect(result.output).not.toContain(`QUARANTINED ${arbitraryPath}`);
    expect(result.output).toContain("Regressions with wasm-hash change: 1");
  });

  it("keeps the workflow-parsed compile-time lines authoritative for stable paths", () => {
    const [timeoutNoisePath, aggregateNoisePath] = passFlipPaths;
    const stableTimeoutPath = "test/built-ins/Array/stable-timeout.js";
    const stableAggregatePath = "test/built-ins/Array/stable-aggregate.js";
    const result = runDiff(
      [
        { file: timeoutNoisePath, status: "pass", wasm_sha: "aaaaaaaaaaaa", compile_ms: 100 },
        { file: stableTimeoutPath, status: "pass", wasm_sha: "bbbbbbbbbbbb", compile_ms: 100 },
        { file: aggregateNoisePath, status: "pass", wasm_sha: "cccccccccccc", compile_ms: 100 },
        { file: stableAggregatePath, status: "pass", wasm_sha: "dddddddddddd", compile_ms: 100 },
      ],
      [
        { file: timeoutNoisePath, status: "compile_timeout", wasm_sha: null },
        { file: stableTimeoutPath, status: "compile_timeout", wasm_sha: null },
        { file: aggregateNoisePath, status: "pass", wasm_sha: "eeeeeeeeeeee", compile_ms: 10000 },
        { file: stableAggregatePath, status: "pass", wasm_sha: "ffffffffffff", compile_ms: 100 },
      ],
    );

    expect(result.status).toBe(0);
    const firstTimeout = result.output.match(/Compile timeouts \(pass → compile_timeout\): (\d+)/)?.[1];
    const firstAggregate = result.output.match(
      /Aggregate compile time \(shared \d+ tests\):[^\n]*Δ ([+-]?\d+\.\d+)%/,
    )?.[1];
    expect(firstTimeout).toBe("1");
    expect(firstAggregate).toBe("+0.0");
    expect(result.output).toContain("Raw host pass→compile_timeout transitions before canary quarantine: 2");
    expect(result.output).toContain("Host canary-quarantined pass→compile_timeout noise: 1");
    expect(result.output).toContain("Raw host aggregate before canary quarantine");
    expect(result.output).toContain("Host canary-quarantined aggregate contribution");
  });
});
