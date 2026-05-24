// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1607 — codegen stack overflow on self-referential lexical initializers (TDZ).
//
// `const x = x;` / `await using x = x + 1;` reference the binding being declared
// inside its own initializer (a Temporal Dead Zone case). The static numeric
// folder `tryStaticToNumber` traced an identifier back to its const/using
// declaration's initializer with no cycle guard, so it recursed forever and
// threw `RangeError: Maximum call stack size exceeded` during codegen. The
// fix adds a visited-declaration guard that bails to runtime (which then emits
// the spec-required TDZ ReferenceError) instead of recursing.

import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

function hasInternalError(errors: { message: string }[] | undefined): boolean {
  return !!errors?.some((e) => /Maximum call stack|Internal error compiling/.test(e.message));
}

describe("#1607 self-referential lexical initializer (TDZ) must not overflow the compiler", () => {
  // skipSemanticDiagnostics mirrors the test262 runner path that surfaced the crash.
  const cases = [
    "const x = x;",
    "let y = y;",
    "{ const z = z; }",
    "async function f() { await using x = x + 1; }",
    "function f() { using x = x; }",
    "function g() { const x = x + 1; return x; }",
    "function h() { const a: any = a * 2 - a; return a; }",
  ];

  for (const src of cases) {
    it(`compiles without stack overflow: ${JSON.stringify(src)}`, () => {
      const r = compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true });
      expect(hasInternalError(r.errors)).toBe(false);
    });
  }

  it("still constant-folds non-cyclic const arithmetic", () => {
    const src = "export function h(): number { const a = 2; const b = a + 3; return b * 2; }";
    const r = compile(src, { fileName: "test.ts" });
    expect(r.success).toBe(true);
    expect(hasInternalError(r.errors)).toBe(false);
  });
});
