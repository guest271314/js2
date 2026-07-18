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
import {
  loadHostNoiseQuarantine,
  validateHostNoiseQuarantineManifest,
  type HostNoiseQuarantineManifest,
} from "../scripts/diff-test262.js";

interface FixtureRow {
  file: string;
  status: string;
  wasm_sha?: string | null;
  compile_ms?: number;
  error_category?: string;
}

const manifest = JSON.parse(
  readFileSync("scripts/test262-host-noise-quarantine.json", "utf-8"),
) as HostNoiseQuarantineManifest;
const passFlipPaths = manifest.entries
  .filter((entry) => entry.observations.some((observation) => observation.kind === "pass_flip"))
  .map((entry) => entry.path);
const unionOnlyPassFlipPath = manifest.entries.find(
  (entry) =>
    entry.observations.length === 1 && entry.observations.some((observation) => observation.kind === "pass_flip"),
)?.path;
const intersectionPassFlipPath = manifest.entries.find(
  (entry) =>
    entry.observations.length === manifest.provenance.canaries.length &&
    entry.observations.some((observation) => observation.kind === "pass_flip"),
)?.path;

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
  it("pins the audited canary provenance and exact union/intersection sets", () => {
    const loaded = loadHostNoiseQuarantine();
    expect(manifest).toMatchObject({
      schema_version: 2,
      lane: "js-host",
      provenance: {
        canaries: [
          {
            canary_run_id: 29632875780,
            compiler_sha: "852c40a9f5167a2a959d53faa066cb0753b623cc",
            artifact_id: 8426392963,
            compiler_pool_size: 4,
            pass_flips: 360,
            non_pass_status_noise: 150,
            unstable_paths: 510,
          },
          {
            canary_run_id: 29643714720,
            compiler_sha: "dae79d5a311a0bf683341230c39e6c5a7f6176ad",
            artifact_id: 8429653584,
            compiler_pool_size: 4,
            pass_flips: 366,
            non_pass_status_noise: 165,
            unstable_paths: 531,
          },
        ],
      },
      counts: {
        canary_runs: 2,
        pass_flip_observations: 726,
        non_pass_status_noise_observations: 315,
        union_paths: 932,
        intersection_paths: 109,
      },
    });
    expect(loaded.paths.size).toBe(932);
    expect(loaded.intersectionPaths.size).toBe(109);
    expect(new Set(manifest.entries.map((entry) => entry.path)).size).toBe(932);
    expect(unionOnlyPassFlipPath).toBe("test/annexB/built-ins/Date/prototype/getYear/length.js");
    expect(intersectionPassFlipPath).toBe("test/annexB/built-ins/Date/prototype/setYear/length.js");
  });

  it("rejects an observation that is not sourced to a recorded same-SHA canary", () => {
    const invalid = structuredClone(manifest);
    invalid.entries[0].observations[0].canary_run_id = 99999999999;
    expect(() => validateHostNoiseQuarantineManifest(invalid)).toThrow(
      "invalid/duplicate/unsorted Test262 host-noise observation",
    );
  });

  it("passes and fully reports bidirectional churn on canary-known host paths", () => {
    const regressedPath = unionOnlyPassFlipPath!;
    const improvedPath = intersectionPassFlipPath!;
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
    expect(result.output).toContain(`QUARANTINED ${regressedPath}: pass → fail [union-only]`);
    expect(result.output).toContain(`QUARANTINED ${improvedPath}: fail → pass [intersection]`);
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
