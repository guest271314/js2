// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3047 — `var X; function X(){}` same-name coexistence must NOT be rejected as
// "Cannot redeclare block-scoped variable" at Script / function-body top level.
//
// Two root causes were fixed:
//   1. Compiler (`checkVarLexicalConflicts`): a FunctionDeclaration at the top
//      level of a *function body* is VAR-scoped (TopLevelLexicallyDeclaredNames
//      excludes HoistableDeclarations), exactly like at SourceFile scope — so a
//      same-name `var` coexists with it. Previously any `ts.Block` (incl. a
//      function body) treated the function as lexical → false CE.
//   2. Harness (`wrapTest`): every test body is placed inside `try { ... }`; a
//      *genuine nested Block* makes the function lexical, so top-level
//      `var f; function f(){}` wrapped as `try { var f; function f(){} }`
//      becomes a real SyntaxError (V8 agrees). The wrapper now hoists such a
//      coexisting function declaration out of the `try` to the test() body top
//      level, restoring the legal script scope.
//
// Genuine nested-block redeclarations (`{ var f; function f(){} }`, `{ let x;
// function x(){} }`, `{ var f; { var f } }` with a lexical `f`) MUST still be
// rejected — Annex B relaxes only the duplicate-FunctionDeclaration rule, never
// lexical-vs-var. test262 carries negative (parse SyntaxError) tests for these.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { wrapTest, parseMeta } from "./test262-runner.js";

const REDECLARE = "Cannot redeclare block-scoped variable";

async function errorMessages(source: string): Promise<string[]> {
  const r = await compile(source, { fileName: "test.ts" });
  return (r.errors ?? []).map((e) => e.message);
}

function hasRedeclareCE(msgs: string[]): boolean {
  return msgs.some((m) => m.includes(REDECLARE));
}

describe("#3047 — var/function same-name coexistence at var-scope top level", () => {
  it("does NOT emit a redeclare CE for `var f; function f(){}` at function-body top level", async () => {
    const msgs = await errorMessages(`
      function outer(): number {
        var f;
        function f() { return 7; }
        return 1;
      }
    `);
    expect(hasRedeclareCE(msgs)).toBe(false);
  });

  it("does NOT emit a redeclare CE for the reverse order (`function f(){} var f;`)", async () => {
    const msgs = await errorMessages(`
      function outer(): number {
        function f() { return 7; }
        var f;
        return 1;
      }
    `);
    expect(hasRedeclareCE(msgs)).toBe(false);
  });

  it("does NOT emit a redeclare CE inside a method body", async () => {
    const msgs = await errorMessages(`
      class C {
        m(): number {
          var x;
          function x() { return 1; }
          return 1;
        }
      }
    `);
    expect(hasRedeclareCE(msgs)).toBe(false);
  });

  it("does NOT emit a redeclare CE inside an arrow-function body", async () => {
    const msgs = await errorMessages(`
      const a = (): number => {
        var x;
        function x() { return 1; }
        return 1;
      };
    `);
    expect(hasRedeclareCE(msgs)).toBe(false);
  });

  it("still compiles `var f; function f(){}` at Script (SourceFile) top level", async () => {
    const msgs = await errorMessages(`var f; function f() {} f();`);
    expect(hasRedeclareCE(msgs)).toBe(false);
  });

  // ── Regression guards: genuine nested-block redeclarations MUST still error ──

  it("STILL rejects `{ var f; function f(){} }` in a genuine nested block", async () => {
    const msgs = await errorMessages(`{ var f; function f() {} }`);
    expect(hasRedeclareCE(msgs)).toBe(true);
  });

  it("STILL rejects the reverse `{ function f(){} var f; }` in a nested block", async () => {
    const msgs = await errorMessages(`{ function f() {} var f; }`);
    expect(hasRedeclareCE(msgs)).toBe(true);
  });

  it("STILL rejects `if (true) { var f; function f(){} }`", async () => {
    const msgs = await errorMessages(`if (true) { var f; function f() {} }`);
    expect(hasRedeclareCE(msgs)).toBe(true);
  });

  it("STILL rejects an inner-block var against an outer-block function", async () => {
    const msgs = await errorMessages(`{ function f() {} { var f; } }`);
    expect(hasRedeclareCE(msgs)).toBe(true);
  });

  it("STILL rejects a genuine let/var conflict in a nested block", async () => {
    const msgs = await errorMessages(`{ let x; { var x; } }`);
    // any lexical-vs-var diagnostic is acceptable here; it must NOT silently compile
    const r = await compile(`{ let x; { var x; } }`, { fileName: "test.ts" });
    expect(r.success).toBe(false);
    void msgs;
  });
});

describe("#3047 — test262 harness hoists a coexisting top-level function out of try{}", () => {
  it("removes the redeclare CE for a synthetic `var f; function f(){}` top-level test", async () => {
    const src = `/*---\ndescription: var/function coexistence\n---*/\nvar f;\nfunction f() {}\n`;
    const w = wrapTest(src, parseMeta(src));
    const wrapped = typeof w === "string" ? w : w.source;
    expect(wrapped).toContain("#3047: function declaration hoisted");
    const msgs = await errorMessages(wrapped);
    expect(hasRedeclareCE(msgs)).toBe(false);
  });

  it("leaves a body WITHOUT the coexistence pattern byte-unchanged (no hoist marker)", async () => {
    const src = `/*---\ndescription: plain\n---*/\nvar a = 1;\nfunction g() { return a; }\nassert.sameValue(g(), 1);\n`;
    const w = wrapTest(src, parseMeta(src));
    const wrapped = typeof w === "string" ? w : w.source;
    // `g` has no coexisting `var g`, so nothing is hoisted.
    expect(wrapped).not.toContain("#3047: function declaration hoisted");
  });
});
