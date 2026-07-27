/**
 * #3683 S1 — prototype-method write-once analysis pins.
 *
 * The analysis feeds the (future) typed-`this` twin emission, so its
 * guarantees are one-sided: a published verdict MUST be a provably
 * write-once, top-level, function-valued prototype slot of an un-poisoned
 * class; everything ambiguous must be demoted or poison the class. The last
 * test pins the analysis against the REAL pinned acorn source — the workload
 * #3683 exists for — so a future refactor can't silently regress admission
 * to zero (or admit a mutable slot).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeProtoMethodWriteOnce } from "../src/codegen/fnctor-escape-gate.ts";
import { ts } from "../src/ts-api.ts";
import { setupAcorn } from "./dogfood/setup-acorn.mjs";

function analyze(source: string) {
  const sf = ts.createSourceFile("t.ts", source, ts.ScriptTarget.ES2022, true);
  return analyzeProtoMethodWriteOnce(sf);
}

describe("#3683 S1 — prototype-method write-once analysis", () => {
  it("admits direct and aliased top-level single assignments", () => {
    const r = analyze(`
      function F(x) { this.x = x; }
      F.prototype.direct = function () { return this.x; };
      var pp = F.prototype;
      pp.aliased = function () { return this.x + 1; };
    `);
    expect(r.poisoned.has("F")).toBe(false);
    expect(r.methods.get("F")?.has("direct")).toBe(true);
    expect(r.methods.get("F")?.has("aliased")).toBe(true);
  });

  it("demotes a double-assigned method without poisoning the class", () => {
    const r = analyze(`
      function F() {}
      F.prototype.m = function () { return 1; };
      F.prototype.m = function () { return 2; };
      F.prototype.keep = function () { return 3; };
    `);
    expect(r.poisoned.has("F")).toBe(false);
    expect(r.methods.get("F")?.has("m")).toBe(false);
    expect(r.methods.get("F")?.has("keep")).toBe(true);
  });

  it("demotes conditional / nested assignments", () => {
    const r = analyze(`
      function F() {}
      if (globalThis.flag) { F.prototype.cond = function () { return 1; }; }
      function install() { F.prototype.inner = function () { return 2; }; }
      F.prototype.top = function () { return 3; };
    `);
    expect(r.methods.get("F")?.has("cond")).toBe(false);
    expect(r.methods.get("F")?.has("inner")).toBe(false);
    expect(r.methods.get("F")?.has("top")).toBe(true);
  });

  it("poisons on prototype reassignment, computed writes, delete, and escape", () => {
    const r = analyze(`
      function A() {}
      A.prototype = { m: function () {} };
      function B() {}
      B.prototype.m = function () {};
      B.prototype["dyn" + 1] = function () {};
      function C() {}
      C.prototype.m = function () {};
      delete C.prototype.m;
      function D() {}
      D.prototype.m = function () {};
      Object.assign(D.prototype, { extra: function () {} });
    `);
    for (const name of ["A", "B", "C", "D"]) expect(r.poisoned.has(name)).toBe(true);
    expect(r.methods.has("B")).toBe(false);
    expect(r.methods.has("C")).toBe(false);
    expect(r.methods.has("D")).toBe(false);
  });

  it("whitelists Object.create/getPrototypeOf argument reads", () => {
    const r = analyze(`
      function Base() {}
      Base.prototype.m = function () { return 1; };
      function Sub() {}
      Sub.prototype = Object.create(Base.prototype);
      var proto = Object.getPrototypeOf(new Base());
    `);
    expect(r.poisoned.has("Base")).toBe(false);
    expect(r.poisoned.has("Sub")).toBe(true); // its own prototype reassigned
    expect(r.methods.get("Base")?.has("m")).toBe(true);
  });

  it("poisons both owners on an alias-name collision", () => {
    const r = analyze(`
      function A() {}
      function B() {}
      var pp = A.prototype;
      pp.m1 = function () {};
      var pp = B.prototype;
      pp.m2 = function () {};
    `);
    expect(r.poisoned.has("A")).toBe(true);
    expect(r.poisoned.has("B")).toBe(true);
    expect(r.methods.size).toBe(0);
  });

  it("REAL ACORN: Parser publishes a healthy write-once method set", () => {
    const { entryModulePath } = setupAcorn();
    const source = readFileSync(entryModulePath, "utf-8");
    const sf = ts.createSourceFile("acorn.mjs", source, ts.ScriptTarget.ES2022, true);
    const r = analyzeProtoMethodWriteOnce(sf);
    expect(r.poisoned.has("Parser")).toBe(false);
    const parser = r.methods.get("Parser");
    expect(parser).toBeDefined();
    // The tokenizer/statement/expression methods #3673 profiled as hot.
    for (const m of ["readToken", "next", "finishNode", "parseExpression", "eat"]) {
      expect(parser?.has(m), `Parser.prototype.${m} should be write-once`).toBe(true);
    }
    // Broad admission: acorn assigns ~200 prototype methods once at init.
    expect((parser?.size ?? 0) > 100).toBe(true);
  });
});
