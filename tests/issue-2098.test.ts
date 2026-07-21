import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

function writeJsonl(path: string, records: Record<string, unknown>[]) {
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function runDiff(baseline: string, candidate: string): { code: number; out: string } {
  try {
    const out = execFileSync("npx", ["tsx", "scripts/diff-test262.ts", baseline, candidate], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err: any) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

describe("#2098 flake classification + bucket signature in diff-test262", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  function paths() {
    tmpDir = mkdtempSync(join(tmpdir(), "issue-2098-"));
    return { base: join(tmpDir, "base.jsonl"), cand: join(tmpDir, "cand.jsonl"), cand2: join(tmpDir, "cand2.jsonl") };
  }

  it("splits compile_timeout regressions into ct_flake (≤5s baseline) and ct_suspect (>5s/unknown)", () => {
    const p = paths();
    writeJsonl(p.base, [
      { oracle_version: 1, file: "fast.js", status: "pass", compile_ms: 1200 },
      { oracle_version: 1, file: "slow.js", status: "pass", compile_ms: 8000 },
      { oracle_version: 1, file: "unk.js", status: "pass" },
    ]);
    writeJsonl(p.cand, [
      { oracle_version: 1, file: "fast.js", status: "compile_timeout" },
      { oracle_version: 1, file: "slow.js", status: "compile_timeout" },
      { oracle_version: 1, file: "unk.js", status: "compile_timeout" },
    ]);
    const { out } = runDiff(p.base, p.cand);
    expect(out).toMatch(/ct_flake.*: 1 ===/);
    expect(out).toMatch(/ct_suspect.*: 2 ===/);
    expect(out).toMatch(/ct_suspect slow\.js \(baseline compile 8000ms\)/);
    expect(out).toMatch(/ct_suspect unk\.js \(baseline compile unknown\)/);
  });

  it("surfaces compile_timeout recoveries without counting exposed traps as trap growth", () => {
    const p = paths();
    writeJsonl(p.base, [
      { oracle_version: 1, file: "fast-trap.js", status: "compile_timeout" },
      { oracle_version: 1, file: "slow-trap.js", status: "compile_timeout" },
    ]);
    writeJsonl(p.cand, [
      {
        oracle_version: 1,
        file: "fast-trap.js",
        status: "fail",
        error_category: "null_deref",
        compile_ms: 700,
      },
      {
        oracle_version: 1,
        file: "slow-trap.js",
        status: "fail",
        error_category: "oob",
        compile_ms: 8000,
      },
    ]);
    const { code, out } = runDiff(p.base, p.cand);
    expect(code).toBe(0);
    expect(out).toMatch(/ct_flake recoveries.*: 1 ===/);
    expect(out).toMatch(/ct_suspect recoveries.*: 1 ===/);
    expect(out).toMatch(/Trap baseline unknowns .*: 2 ===/);
    expect(out).not.toMatch(/GATE FAIL: trap category/);
  });

  it("treats a candidate trap with no baseline row as unknown and surfaces the missing evidence", () => {
    const p = paths();
    writeJsonl(p.base, [{ oracle_version: 1, file: "control.js", status: "pass", wasm_sha: "same" }]);
    writeJsonl(p.cand, [
      { oracle_version: 1, file: "control.js", status: "pass", wasm_sha: "same" },
      {
        oracle_version: 1,
        file: "omitted-by-baseline.js",
        status: "fail",
        error_category: "oob",
        wasm_sha: "candidate-only",
      },
    ]);

    const { code, out } = runDiff(p.base, p.cand);
    expect(code).toBe(0);
    expect(out).toMatch(/Trap baseline unknowns \(absent\/compile_timeout → trap; excluded from #3189\): 1 ===/);
    expect(out).toMatch(/oob: omitted-by-baseline\.js \(baseline absent\)/);
    expect(out).not.toMatch(/GATE FAIL: trap category/);
  });

  it("still ratchets an observed baseline nontrap into a candidate trap", () => {
    const p = paths();
    writeJsonl(p.base, [
      {
        oracle_version: 1,
        file: "observed-nontrap.js",
        status: "fail",
        error_category: "assertion_fail",
        wasm_sha: "before",
      },
    ]);
    writeJsonl(p.cand, [
      {
        oracle_version: 1,
        file: "observed-nontrap.js",
        status: "fail",
        error_category: "oob",
        wasm_sha: "after",
      },
    ]);

    const { code, out } = runDiff(p.base, p.cand);
    expect(code).toBe(1);
    expect(out).toMatch(/GATE FAIL: trap category "oob" grew 0 → 1/);
    expect(out).toMatch(/Newly trapping: observed-nontrap\.js/);
  });

  it("emits a bucket signature stable across row order and wasm_sha (cluster identity)", () => {
    const p = paths();
    writeJsonl(p.base, [
      { oracle_version: 1, file: "a.js", status: "pass", wasm_sha: "x1" },
      { oracle_version: 1, file: "b.js", status: "pass", wasm_sha: "y1" },
      { oracle_version: 1, file: "ct.js", status: "pass", compile_ms: 100 },
    ]);
    writeJsonl(p.cand, [
      { oracle_version: 1, file: "a.js", status: "fail", wasm_sha: "x2" },
      { oracle_version: 1, file: "b.js", status: "fail", wasm_sha: "y2" },
      { oracle_version: 1, file: "ct.js", status: "compile_timeout" },
    ]);
    // Same cluster, rows reordered + different wasm_sha + the CT row dropped.
    writeJsonl(p.cand2, [
      { oracle_version: 1, file: "b.js", status: "fail", wasm_sha: "z9" },
      { oracle_version: 1, file: "ct.js", status: "compile_timeout" },
      { oracle_version: 1, file: "a.js", status: "fail", wasm_sha: "w0" },
    ]);

    const sig = (out: string) => out.match(/Regression bucket signature: ([0-9a-f]{16})/)?.[1];
    const s1 = sig(runDiff(p.base, p.cand).out);
    const s2 = sig(runDiff(p.base, p.cand2).out);
    expect(s1).toBeDefined();
    expect(s1).toBe(s2);
  });

  it("changes the bucket signature when the regressing cluster differs", () => {
    const p = paths();
    writeJsonl(p.base, [
      { oracle_version: 1, file: "a.js", status: "pass", wasm_sha: "x1" },
      { oracle_version: 1, file: "b.js", status: "pass", wasm_sha: "y1" },
    ]);
    writeJsonl(p.cand, [
      { oracle_version: 1, file: "a.js", status: "fail", wasm_sha: "x2" },
      { oracle_version: 1, file: "b.js", status: "pass", wasm_sha: "y1" },
    ]);
    writeJsonl(p.cand2, [
      { oracle_version: 1, file: "a.js", status: "pass", wasm_sha: "x1" },
      { oracle_version: 1, file: "b.js", status: "fail", wasm_sha: "y2" },
    ]);
    const sig = (out: string) => out.match(/Regression bucket signature: ([0-9a-f]{16})/)?.[1];
    const s1 = sig(runDiff(p.base, p.cand).out);
    const s2 = sig(runDiff(p.base, p.cand2).out);
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
    expect(s1).not.toBe(s2);
  });
});
