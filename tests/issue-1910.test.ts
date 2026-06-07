import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("#1910 standalone ToPrimitive residual classifier split", () => {
  let tmpDir: string;
  let buckets: Map<string, any>;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "issue-1910-"));
    const input = join(tmpDir, "results.jsonl");
    const output = join(tmpDir, "report.json");

    const records = [
      {
        file: "test/language/expressions/addition/object-toprimitive.js",
        category: "language/expressions",
        status: "fail",
        error_category: "runtime_error",
        error_signature: "runtime_error:Cannot convert object to primitive value",
      },
      {
        file: "test/built-ins/String/fromCodePoint/argument-not-coercible.js",
        category: "built-ins/String",
        status: "fail",
        error_category: "runtime_error",
        error_signature: "runtime_error:Cannot convert object to primitive value",
      },
      {
        file: "test/built-ins/decodeURI/S15.1.3.1_A1.12_T2.js",
        category: "built-ins/decodeURI",
        status: "fail",
        error_category: "runtime_error",
        error_signature: "runtime_error:L#:## Cannot convert object to primitive value",
      },
      {
        file: "test/built-ins/Date/coercion-errors.js",
        category: "built-ins/Date",
        status: "fail",
        error_category: "runtime_error",
        error_signature: "runtime_error:Cannot convert object to primitive value",
      },
      {
        file: "test/built-ins/RegExp/prototype/Symbol.match/coerce-this.js",
        category: "built-ins/RegExp",
        status: "fail",
        error_category: "runtime_error",
        error_signature: "runtime_error:Cannot convert object to primitive value",
      },
      {
        file: "test/language/expressions/tagged-template/template-object-frozen-strict.js",
        category: "language/expressions",
        status: "fail",
        error_category: "assertion_fail",
        error_signature: "assertion_fail:returned # -- toString was called",
      },
      {
        file: "test/built-ins/Object/defineProperties/descriptor-toprimitive.js",
        category: "built-ins/Object",
        status: "fail",
        error_category: "runtime_error",
        error_signature: "runtime_error:Cannot convert object to primitive value",
      },
      {
        file: "test/built-ins/BigInt/toprimitive.js",
        category: "built-ins/BigInt",
        status: "fail",
        error_category: "runtime_error",
        error_signature: "runtime_error:Cannot convert object to primitive value",
      },
      {
        file: "test/built-ins/Function/constructor-toprimitive.js",
        category: "built-ins/Function",
        status: "fail",
        error_category: "runtime_error",
        error_signature: "runtime_error:Cannot convert object to primitive value",
      },
    ];

    writeFileSync(input, records.map((record) => JSON.stringify(record)).join("\n"));
    execFileSync(
      "node",
      ["scripts/build-test262-report.mjs", "--input", input, "--output", output, "--target", "standalone"],
      { cwd: process.cwd(), stdio: "pipe" },
    );

    const report = JSON.parse(readFileSync(output, "utf8"));
    buckets = new Map(report.root_cause_map.buckets.map((bucket: any) => [bucket.id, bucket]));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps the generic ToPrimitive bucket scoped to real residual operator paths", () => {
    expect(buckets.get("object-to-primitive")?.count).toBe(1);
    expect(buckets.get("object-to-primitive")?.issues).toEqual(["#1910", "#1525b", "#1900", "#1472"]);
  });

  it("routes string, URI, Date, RegExp, template, object, BigInt, and Function overmatches elsewhere", () => {
    expect(buckets.get("string-methods-coercion")?.count).toBe(2);
    expect(buckets.get("date-formatting-coercion")?.count).toBe(1);
    expect(buckets.get("standalone-regexp-string-protocol")?.count).toBe(1);
    expect(buckets.get("template-literals")?.count).toBe(1);
    expect(buckets.get("object-property-semantics")?.count).toBe(1);
    expect(buckets.get("bigint-typed-path")?.count).toBe(1);
    expect(buckets.get("function-object-semantics")?.count).toBe(1);
  });
});
