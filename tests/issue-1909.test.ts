import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

function writeJsonl(path: string, records: Record<string, unknown>[]) {
  writeFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}

function buildStandaloneReport(input: string, output: string) {
  execFileSync(
    "node",
    [
      "scripts/build-test262-report.mjs",
      "--input",
      input,
      "--output",
      output,
      "--target",
      "standalone",
      "--max-unclassified-root-causes",
      "0",
    ],
    { cwd: process.cwd(), stdio: "pipe" },
  );
  return JSON.parse(readFileSync(output, "utf-8"));
}

describe("#1909 standalone RegExp residual classifier split", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it("routes representative RegExp residual signatures to current child owners", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "issue-1909-"));
    const input = join(tmpDir, "test262-standalone-results.jsonl");
    const output = join(tmpDir, "test262-standalone-report.json");

    writeJsonl(input, [
      {
        file: "test/built-ins/RegExp/property-escapes/generated/Script_-_Brahmi.js",
        category: "built-ins/RegExp",
        status: "compile_error",
        error_category: "other",
        error_signature:
          'other:L#:## Codegen error: standalone RegExp engine does not support flags "u" (u/v/d are ## Phase 2d)',
      },
      {
        file: "test/built-ins/RegExp/S15.10.2.6_A3_T4.js",
        category: "built-ins/RegExp",
        status: "compile_error",
        error_category: "other",
        error_signature:
          "other:L#:## Codegen error: standalone RegExp engine does not support word-boundary \\b — ## Phase 2b",
      },
      {
        file: "test/built-ins/RegExp/prototype/Symbol.matchAll/this-get-flags.js",
        category: "built-ins/RegExp",
        status: "compile_error",
        error_category: "other",
        error_signature:
          "other:L#:## Codegen error: standalone RegExp literal-substring backend does not support @@matchAll symbol protocol calls",
      },
      {
        file: "test/language/literals/regexp/S7.8.5_A2.4_T2.js",
        category: "language/literals/regexp",
        status: "fail",
        error_category: "assertion_fail",
        error_signature:
          'assertion_fail:returned # — assert ## at L#: assert.sameValue(pattern.source, xx, "Code unit: " + cu.toString(#));',
      },
      {
        file: "test/built-ins/RegExp/basic-unmatched-residual.js",
        category: "built-ins/RegExp",
        status: "compile_error",
        error_category: "other",
        error_signature: "other:L#:## No dependency provided for imported function env::RegExp_new",
        host_import_leak_class: "regexp",
      },
    ]);

    const report = buildStandaloneReport(input, output);
    const byId = new Map(report.root_cause_map.buckets.map((bucket: any) => [bucket.id, bucket]));

    expect(report.root_cause_map.unclassified.count).toBe(0);
    expect(byId.get("standalone-regexp-phase-2d").issues).toContain("#1911");
    expect(byId.get("standalone-regexp-phase-2b").issues).toContain("#1912");
    expect(byId.get("standalone-regexp-string-protocol").issues).toContain("#1913");
    expect(byId.get("standalone-regexp-native-engine").issues).toContain("#1914");
    expect(byId.get("standalone-regexp").issues).toEqual(["#1909", "#1911", "#1912", "#1913", "#1914"]);

    expect(byId.get("standalone-regexp-phase-2d").count).toBe(1);
    expect(byId.get("standalone-regexp-phase-2b").count).toBe(1);
    expect(byId.get("standalone-regexp-string-protocol").count).toBe(1);
    expect(byId.get("standalone-regexp-native-engine").count).toBe(1);
    expect(byId.get("standalone-regexp").count).toBe(1);
  });
});
