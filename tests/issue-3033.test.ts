// #3033 — an `any`-receiver method call must not be hijacked by an ambient
// extern class (lib.dom.d.ts) that happens to declare a same-named method.
//
// Root cause (measured; minimal FF2 repro from the acorn `x.var` bisect):
// `tryExternClassMethodOnAny` (calls-closures.ts) resolves a method call on an
// `any`-typed receiver by FIRST-NAME-MATCH over every registered extern class.
// `p.check()` on a user fnctor instance bound to **FontFaceSet_check** (a DOM
// API import), so the user's `P.prototype.check` never ran and the call
// returned the import's boxed default (`false`). The same hijack family
// produced the historical one-off refusals (slice #1062, replace/replaceAll
// #1712, forEach/some #3014, isPrototypeOf #2994).
//
// Fix: refuse extern-class first-match dispatch whenever the program's OWN
// source defines a function-valued member of that name (prototype-method
// assignment, function-valued property assignment, object-literal method,
// class method). The call then falls through to the generic dynamic dispatch,
// which resolves by the receiver's REAL runtime identity — correct for user
// objects AND for genuine host objects.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { wrapExports } from "../src/runtime.js";

async function run(src: string): Promise<any> {
  const result: any = await compile(src, { fileName: "test.mjs", skipSemanticDiagnostics: true } as any);
  expect(result.binary?.length).toBeGreaterThan(0);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return wrapExports(instance.exports, { signatures: result.exportSignatures });
}

describe("#3033 — user-defined member names are not hijacked by ambient extern classes", () => {
  // The minimal acorn-bisect repro (FF2): three module-level fnctors, direct
  // prototype assignment. Pre-fix `p.check()` compiled to FontFaceSet_check
  // and returned false without running the user method.
  it("dispatches p.check() to the user's prototype method, not FontFaceSet.check", async () => {
    const exp = await run(`
var TokenType = function TokenType(label) { this.label = label; };
var tt = { name: new TokenType("name") };
var Node = function Node() { this.kind = ""; };
var P = function P() { this.type = tt.name; };
P.prototype.check = function() { return "ran"; };
export function test() { var p = new P(); return p.check(); }
`);
    expect(exp.test()).toBe("ran");
  });

  // The acorn TokenType truthiness shape (BB1): with a colliding string-typed
  // `type` field on another shape, `check()` must still dispatch and the
  // keyword field read + truthiness must hold.
  it("prototype method reads this-fields correctly despite a type-field collision", async () => {
    const exp = await run(`
var TokenType = function TokenType(label, conf) {
  if (conf === void 0) conf = {};
  this.label = label;
  this.keyword = conf.keyword;
};
var tt = { name: new TokenType("name", { startsExpr: true }), _var: new TokenType("var", { keyword: "var" }) };
var Node = function Node() { this.type = ""; };
var P = function P() { this.type = tt.name; };
P.prototype.check = function() {
  this.type = tt._var;
  if (this.type === tt.name) { return "name-branch"; }
  else if (this.type.keyword) { return "kw:" + this.type.keyword; }
  else { return "unexpected"; }
};
export function test() {
  var n = new Node();
  n.type = "Identifier";
  var p = new P();
  return p.check() + "|" + n.type;
}
`);
    expect(exp.test()).toBe("kw:var|Identifier");
  });

  // Alias-form prototype assignment (acorn's `var pp = Parser.prototype;
  // pp.method = fn` pattern) — the collector must catch the assignment name
  // regardless of how the prototype object is reached.
  it("alias-assigned prototype method (pp.load) beats a DOM name (FontFace.load)", async () => {
    const exp = await run(`
var Extra = function Extra() { this.kind = 0; };
var P = function P() { this.state = 7; };
var pp = P.prototype;
pp.load = function() { return "user-load:" + this.state; };
export function test() { var p = new P(); return p.load(); }
`);
    expect(exp.test()).toBe("user-load:7");
  });

  // Guard: a name the user does NOT define keeps the historical extern-class
  // first-match behavior — Map.get on an any-typed receiver still works.
  it("does not regress any-receiver dispatch for names the user never defines", async () => {
    const exp = await run(`
export function test() {
  var m = new Map();
  m.set("k", 41);
  return m.get("k") + 1;
}
`);
    expect(exp.test()).toBe(42);
  });
});
