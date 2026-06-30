// #2898 — `yield` as an assignment target must be an early SyntaxError.
//
// test262 `language/expressions/assignmenttargettype/direct-yieldexpression-0.js`
// is a `negative: { phase: parse, type: SyntaxError }` test whose body is
// `yield x = 1;` at the top level of a script. TypeScript leniently parses that
// as a YieldExpression(`x = 1`) even though `yield` outside a generator is not a
// yield expression at all — so the early-error pass previously let it compile.
//
// Fix: a YieldExpression that is not inside ANY function is always invalid
// (yield is only valid inside a generator, which is a function), so it is flagged
// as an early SyntaxError. The rule is deliberately the SOUND `!isInsideFunction`
// invariant — a `[yield]` ComputedPropertyName on a non-generator method *inside*
// a generator is valid (evaluated in the enclosing generator scope) and must stay
// accepted; those sit under a MethodDeclaration so they are untouched.
import { describe, it, expect } from "vitest";
import { ts } from "../src/ts-api.js";
import { detectEarlyErrors } from "../src/compiler/validation.js";

function earlyErrors(src: string) {
  const sf = ts.createSourceFile("test.js", src, ts.ScriptTarget.ESNext, /*setParentNodes*/ true, ts.ScriptKind.JS);
  return detectEarlyErrors(sf);
}

function hasYieldError(src: string): boolean {
  return earlyErrors(src).some((e) => e.severity === "error" && /yield/i.test(e.message));
}

describe("#2898 — top-level yield expression is an early SyntaxError", () => {
  it("rejects `yield x = 1;` (the assignmenttargettype negative test body)", () => {
    expect(hasYieldError("yield x = 1;")).toBe(true);
  });

  it("rejects a bare top-level `yield 1;`", () => {
    expect(hasYieldError("yield 1;")).toBe(true);
  });

  // Note: `yield * x = 1;` and `yield* g();` at the top level are NOT
  // YieldExpressions — sloppy-mode TS reads them as `(yield) * (...)`
  // multiplication with `yield` as an identifier, which is syntactically valid.
  // The matching test262 negative test (direct-yieldexpression-1) is covered by
  // other early-error/warning paths, not this rule.

  // ── Must stay accepted: valid generator yields ───────────────────────────
  it.each([
    ["yield in a generator declaration", "function* g(){ yield 1; }"],
    ["yield as RHS of assignment in a generator", "function* g(){ x = yield 1; }"],
    ["bare yield in a generator", "function* g(){ yield; }"],
    ["yield* delegation in a generator", "function* g(){ yield* h(); }"],
    ["async generator yield", "async function* g(){ yield 1; }"],
    ["class generator method yield", "class C { *m(){ yield 1; } }"],
    ["object generator method yield", "({ *m(){ yield 1; } });"],
  ])("accepts %s", (_label, src) => {
    expect(hasYieldError(src)).toBe(false);
  });

  // ── Regression guards: `[yield]` computed property name inside a generator ──
  // The computed name is evaluated in the enclosing generator's scope, so the
  // yield is valid even though it sits under a *non-generator* method.
  it("accepts `[yield]` computed prop name on a method inside a generator", () => {
    const src = "var iter = (function*() { ({ [yield]() {} }); })();";
    expect(hasYieldError(src)).toBe(false);
  });

  it("accepts `[yield 9]` computed class-member names inside a generator", () => {
    const src = "function * g() { let C = class { [yield 9]() { return 9; } static [yield 9]() { return 9; } }; }";
    expect(hasYieldError(src)).toBe(false);
  });

  // ── Must stay accepted: `yield` as a sloppy-mode identifier ──────────────
  // TS parses these as Identifier nodes (not YieldExpression), so the rule never
  // fires; assert it explicitly to lock the boundary.
  it.each([["var yield = 1;"], ["yield = 1;"], ["yield;"]])("accepts sloppy identifier use %s", (src) => {
    expect(hasYieldError(src)).toBe(false);
  });
});
