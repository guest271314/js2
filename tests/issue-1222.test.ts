/**
 * #1222 — wasm-hash noise filter for PR regression gate.
 *
 * The dev-self-merge gate counts pass→fail transitions as regressions, but
 * symmetric flip noise (CI runner variance: scheduling, memory pressure, GC
 * timing) inflates that count even when the compiled Wasm binary is byte-
 * identical on both base and branch. Pass→fail flips on identical Wasm cannot
 * be real compiler regressions.
 *
 * The fix is to record a 12-char sha256 hex digest of the binary in each
 * test262 result entry, and to filter regressions in `diff-test262.ts` so
 * that byte-identical "regressions" no longer count.
 *
 * This test verifies:
 *   1. `computeWasmSha` returns a 12-char hex string for a real binary
 *   2. The hash is deterministic — same input source produces the same hash
 *   3. Distinct sources produce distinct hashes
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../src/index.js";
import { computeWasmSha } from "./test262-runner.js";

const HEX_12 = /^[0-9a-f]{12}$/;

async function compileSimple(src: string): Promise<Uint8Array> {
  const result = await compile(src, { fileName: "test.ts" });
  if (!result.success) {
    const errs = result.errors.map((e) => `L${e.line}:${e.column} ${e.message}`).join("; ");
    throw new Error(`compile failed: ${errs}`);
  }
  return result.binary;
}

describe("#1222 — wasm-hash noise filter", () => {
  it("computeWasmSha returns a 12-char lowercase hex digest", async () => {
    const binary = await compileSimple(`export function test(): number { return 1; }`);
    const sha = computeWasmSha(binary);
    expect(sha).toMatch(HEX_12);
    expect(sha.length).toBe(12);
  });

  it("is deterministic — compiling the same snippet twice yields the same sha", async () => {
    const src = `export function test(): number { return 42; }`;
    const a = computeWasmSha(await compileSimple(src));
    const b = computeWasmSha(await compileSimple(src));
    expect(a).toBe(b);
    expect(a).toMatch(HEX_12);
  });

  it("is sensitive to source changes — distinct sources yield distinct shas", async () => {
    const a = computeWasmSha(await compileSimple(`export function test(): number { return 1; }`));
    const b = computeWasmSha(await compileSimple(`export function test(): number { return 2; }`));
    // Different return values produce a different f64.const operand in the
    // emitted Wasm, so the binaries cannot be byte-identical even after
    // constant folding.
    expect(a).not.toBe(b);
    expect(a).toMatch(HEX_12);
    expect(b).toMatch(HEX_12);
  });

  it("hashes raw Uint8Array bytes (independent of compiler)", () => {
    // Cover the pure-function contract: feed the same bytes, get the same hash;
    // change a single byte, get a different hash. This protects the regression-
    // gate filter from upstream changes to the compiler.
    const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const a = computeWasmSha(bytes);
    const b = computeWasmSha(bytes);
    expect(a).toBe(b);

    const mutated = new Uint8Array(bytes);
    mutated[0] = 0xff;
    const c = computeWasmSha(mutated);
    expect(c).not.toBe(a);
    expect(c).toMatch(HEX_12);
  });

  it("diff-test262 exits non-zero for net-negative wasm-changing regressions", () => {
    const dir = mkdtempSync(join(tmpdir(), "diff-test262-net-"));
    try {
      const baseline = join(dir, "baseline.jsonl");
      const candidate = join(dir, "candidate.jsonl");
      writeFileSync(baseline, `${JSON.stringify({ file: "a.js", status: "pass", wasm_sha: "aaaaaaaaaaaa" })}\n`);
      writeFileSync(
        candidate,
        `${JSON.stringify({
          file: "a.js",
          status: "compile_error",
          error_category: "wasm_compile",
          wasm_sha: null,
        })}\n`,
      );

      expect(() =>
        execFileSync(process.execPath, [
          "--experimental-strip-types",
          "scripts/diff-test262.ts",
          baseline,
          candidate,
          "--quiet",
        ]),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("diff-test262 exits zero when improvements offset wasm-changing regressions", () => {
    const dir = mkdtempSync(join(tmpdir(), "diff-test262-net-"));
    try {
      const baseline = join(dir, "baseline.jsonl");
      const candidate = join(dir, "candidate.jsonl");
      writeFileSync(
        baseline,
        [
          { file: "a.js", status: "pass", wasm_sha: "aaaaaaaaaaaa" },
          { file: "b.js", status: "fail", wasm_sha: null },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      writeFileSync(
        candidate,
        [
          { file: "a.js", status: "compile_error", error_category: "wasm_compile", wasm_sha: null },
          { file: "b.js", status: "pass", wasm_sha: "bbbbbbbbbbbb" },
        ]
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );

      const out = execFileSync(process.execPath, [
        "--experimental-strip-types",
        "scripts/diff-test262.ts",
        baseline,
        candidate,
        "--quiet",
      ]).toString();
      expect(out).toContain("=== Net: +0 pass (1 → 1) ===");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
