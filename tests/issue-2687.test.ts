// #2687 — acorn parse() ExpressionStatement.expression was null because a
// higher-arity prototype method (acorn's `parseSubscript`, arity 7) could not be
// dispatched through the host method-call bridge.
//
// ROOT CAUSE (pinned, dev probe 2026-06-27): the compiler emitted
// `__call_fn_method_<N>` dispatchers only for N=0..5 (the highest being the
// #1712 fnctor arity-5 bridge). A `this.parseSubscript(...)` call on an
// `any`/externref receiver wraps the lifted prototype closure and dispatches it
// through `__call_fn_method_<N>` (runtime.ts wasmClosureBridge /
// wasmClosureDynamicBridge). Each dispatcher's filter is
// `info.paramTypes.length <= arity`, so an arity-7 closure was OMITTED from the
// highest-available `__call_fn_method_5` → the dynamic method call returned null
// and the method body NEVER RAN. parseSubscript therefore returned null up the
// expression chain (parseExprSubscripts → parseMaybeUnary → … → parseExpression),
// and `parseExpressionStatement(node, expr)` attached a null `expr`, leaving
// `ExpressionStatement.expression === null`.
//
// FIX: emit `__call_fn_method_<N>` up to the module's actual max closure arity,
// capped at 8 (the dynamic bridge's scan range). This is the symmetric companion
// to #2664 (which fixed FEWER-args-than-params); here the method's DECLARED arity
// EXCEEDED the highest dispatcher.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result: any = await compile(src, { fileName: "acorn.mjs" });
  expect(result.success).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#2687 — higher-arity prototype-method host dispatch (acorn parseSubscript shape)", () => {
  it("a 7-param prototype method invoked via this.m(1..7) RUNS (was: null body)", async () => {
    // Mirrors acorn's `Parser.prototype.parseSubscript(base, startPos, startLoc,
    // noCalls, maybeAsyncArrow, optionalChained, forInit)` (arity 7) invoked from
    // another prototype method via `this.parseSubscript(...)`.
    const exp = await run(`
      var Parser = function Parser(input) { this.input = String(input); };
      Parser.prototype.seven = function seven(a, b, c, d, e, f, g) {
        return a + b + c + d + e + f + g;
      };
      Parser.prototype.run = function run() { return this.seven(1, 2, 3, 4, 5, 6, 7); };
      Parser.parse = function parse(input) { return new this(input).run(); };
      export function parse(input) { return Parser.parse(input); }
    `);
    // Before the fix this returned null (→ 0 / NaN in arithmetic) because the
    // arity-7 closure was omitted from __call_fn_method_5.
    expect(exp.parse("x")).toBe(28);
  });

  it("an 8-param prototype method (acorn parsePropertyValue shape) also runs", async () => {
    const exp = await run(`
      var Parser = function Parser(input) { this.input = String(input); };
      Parser.prototype.eight = function eight(a, b, c, d, e, f, g, h) {
        return a + b + c + d + e + f + g + h;
      };
      Parser.prototype.run = function run() { return this.eight(1, 2, 3, 4, 5, 6, 7, 8); };
      Parser.parse = function parse(input) { return new this(input).run(); };
      export function parse(input) { return Parser.parse(input); }
    `);
    expect(exp.parse("x")).toBe(36);
  });

  it("a 6-param prototype method runs (fills the gap between arity-5 bridge and 7/8)", async () => {
    const exp = await run(`
      var Parser = function Parser(input) { this.input = String(input); };
      Parser.prototype.six = function six(a, b, c, d, e, f) { return a + b + c + d + e + f; };
      Parser.prototype.run = function run() { return this.six(10, 20, 30, 40, 50, 60); };
      Parser.parse = function parse(input) { return new this(input).run(); };
      export function parse(input) { return Parser.parse(input); }
    `);
    expect(exp.parse("x")).toBe(210);
  });

  it("low-arity (<=5) prototype-method dispatch is unaffected (regression guard)", async () => {
    const exp = await run(`
      var Parser = function Parser(input) { this.input = String(input); };
      Parser.prototype.two = function two(a, b) { return a * b; };
      Parser.prototype.run = function run() { return this.two(6, 7); };
      Parser.parse = function parse(input) { return new this(input).run(); };
      export function parse(input) { return Parser.parse(input); }
    `);
    expect(exp.parse("x")).toBe(42);
  });
});
