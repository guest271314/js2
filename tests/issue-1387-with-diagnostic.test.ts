// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const ISSUE_1387 = /#1387: with statement requires IR-proven closed-shape lowering/;

async function compileSloppyWith(src: string) {
  return compile(src, {
    allowJs: true,
    fileName: "issue-1387.js",
    skipSemanticDiagnostics: true,
  });
}

describe("#1387 with statement closed-shape proof gate", () => {
  it("refuses object-literal with targets until the IR proves the closed shape soundly", async () => {
    const r = await compileSloppyWith(`function run() {
  var out = 0;
  with ({ a: 1 }) {
    out = a;
  }
}`);

    const msg = r.errors.map((e) => e.message).join("\n");
    expect(msg).toMatch(ISSUE_1387);
    expect(msg).toContain("object literal target");
    expect(msg).toContain("Object.prototype");
    expect(msg).toContain("@@unscopables");
    expect(msg).toContain("key-set/prototype mutation");
    expect(msg).toContain("ECMA-262 14.11.2");
    expect(msg).toContain("9.1.1.2.1");
    expect(msg).toContain("7.3.11");
    expect(msg).toContain("#1472");

    const diag = r.errors.find((e) => ISSUE_1387.test(e.message));
    expect(diag?.line).toBe(3);
    expect(diag?.column).toBeGreaterThan(0);
  });

  it("refuses opaque identifier targets with a shape-specific diagnostic", async () => {
    const r = await compileSloppyWith(`function run(obj) {
  with (obj) {
    value = 1;
  }
}`);

    const msg = r.errors.map((e) => e.message).join("\n");
    expect(msg).toMatch(ISSUE_1387);
    expect(msg).toContain('identifier target "obj"');
    expect(msg).toContain("runtime shape and mutation history are not proven closed");
  });

  it("does not fall back to the generic unsupported statement diagnostic", async () => {
    const r = await compileSloppyWith(`function run() {
  with (makeScope()) {}
}`);

    const messages = r.errors.map((e) => e.message);
    expect(messages.some((m) => m.includes("Unsupported statement: WithStatement"))).toBe(false);
    expect(messages.some((m) => ISSUE_1387.test(m))).toBe(true);
  });
});
