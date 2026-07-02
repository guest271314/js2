// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2913 — the merged test262 report + editions double-counted duplicate result
// rows (no dedup by file), making the headline pass rate non-deterministic when
// a duplicated row's two copies disagreed (compile_error vs fail). This locks in
// the defensive dedup in scripts/build-test262-report.mjs: exactly one row per
// `file`, keeping the WORST status (compile_error > fail > timeout/crash > pass >
// skip) so the totals are deterministic regardless of row order / retry timing.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve(__dirname, "../scripts/build-test262-report.mjs");

function runReport(rows: object[]): any {
  const dir = mkdtempSync(join(tmpdir(), "issue2913-"));
  try {
    const input = join(dir, "in.jsonl");
    const output = join(dir, "out.json");
    writeFileSync(input, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    execFileSync("node", [SCRIPT, "--input", input, "--output", output], { stdio: "pipe" });
    return JSON.parse(readFileSync(output, "utf-8"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const base = {
  oracle_version: 1,
  category: "built-ins/Array",
  scope: "standard",
  scope_official: true,
  strict: "both",
};

describe("#2913 report dedup by file", () => {
  it("counts each file once and keeps the worst status on disagreeing duplicates", () => {
    const report = runReport([
      { ...base, file: "test/a.js", status: "pass" },
      { ...base, file: "test/b.js", status: "pass" }, // dup, worst = fail
      { ...base, file: "test/b.js", status: "fail" },
      { ...base, file: "test/c.js", status: "fail" }, // dup, worst = compile_error
      { ...base, file: "test/c.js", status: "compile_error" },
    ]);
    const s = report.full_summary;
    // 3 distinct files — NOT 5 rows.
    expect(s.total).toBe(3);
    expect(s.pass).toBe(1); // a
    expect(s.fail).toBe(1); // b (worst of pass/fail)
    expect(s.compile_error).toBe(1); // c (worst of fail/compile_error)
  });

  it("is order-independent — reversed duplicate order yields the same totals", () => {
    const forward = runReport([
      { ...base, file: "test/x.js", status: "pass" },
      { ...base, file: "test/x.js", status: "compile_error" },
    ]);
    const reversed = runReport([
      { ...base, file: "test/x.js", status: "compile_error" },
      { ...base, file: "test/x.js", status: "pass" },
    ]);
    expect(forward.full_summary.total).toBe(1);
    expect(reversed.full_summary.total).toBe(1);
    // Worst status wins regardless of order.
    expect(forward.full_summary.compile_error).toBe(1);
    expect(reversed.full_summary.compile_error).toBe(1);
    expect(forward.full_summary.pass).toBe(0);
    expect(reversed.full_summary.pass).toBe(0);
  });

  it("no duplicates: totals equal the row count", () => {
    const report = runReport([
      { ...base, file: "test/a.js", status: "pass" },
      { ...base, file: "test/b.js", status: "fail" },
    ]);
    expect(report.full_summary.total).toBe(2);
  });
});
