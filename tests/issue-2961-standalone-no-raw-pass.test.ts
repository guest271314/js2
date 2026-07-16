import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyError, standaloneHostImportError } from "./test262-runner.js";

describe("#2961 standalone Test262 passes are always host-free", () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it("rejects standalone import manifests with a stable diagnostic", () => {
    expect(
      standaloneHostImportError("standalone", [
        { module: "env", name: "__create_generator" },
        { module: "env", name: "__make_callback" },
      ]),
    ).toBe("standalone target emitted host imports: env::__create_generator, env::__make_callback (#2961)");
    expect(standaloneHostImportError("standalone", [])).toBeUndefined();
    expect(standaloneHostImportError(undefined, [{ module: "env", name: "__create_generator" }])).toBeUndefined();
    expect(classifyError("standalone target emitted host imports: env::__create_generator (#2961)")).toBe(
      "host_import_leak",
    );
  });

  it("reclassifies legacy leaky-pass rows when building a standalone report", () => {
    tempDir = mkdtempSync(join(tmpdir(), "issue-2961-"));
    const input = join(tempDir, "results.jsonl");
    const output = join(tempDir, "report.json");
    writeFileSync(
      input,
      [
        {
          file: "test/host-free.js",
          category: "language/expressions",
          status: "pass",
          scope: "standard",
          scope_official: true,
        },
        {
          file: "test/leaky.js",
          category: "language/expressions",
          status: "pass",
          imports: ["env::__create_generator"],
          host_import_leak_class: "iterator_protocol",
          scope: "standard",
          scope_official: true,
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n") + "\n",
    );

    execFileSync(
      "node",
      ["scripts/build-test262-report.mjs", "--input", input, "--output", output, "--target", "standalone"],
      { cwd: process.cwd(), stdio: "pipe" },
    );

    const report = JSON.parse(readFileSync(output, "utf8"));
    expect(report.summary).toMatchObject({
      total: 2,
      pass: 1,
      compile_error: 1,
      host_free_pass: 1,
    });
    expect(report.summary.leaky_pass).toBeUndefined();
    expect(report.error_categories.host_import_leak).toBe(1);
    expect(report.root_cause_map.total_non_pass_non_skip).toBe(1);
  });

  it("rejects imports in the fork worker before it constructs JS runtime imports", () => {
    const worker = readFileSync("scripts/test262-worker.mjs", "utf8");
    const guard = worker.indexOf('if (target === "standalone" && compileMetadata.imports?.length > 0)');
    const hostSatisfaction = worker.indexOf("const importObj = buildImports", guard);
    expect(guard).toBeGreaterThan(-1);
    expect(hostSatisfaction).toBeGreaterThan(guard);
  });
});
