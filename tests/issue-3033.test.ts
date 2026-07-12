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

// Bug 2b (#3033) — a CHAINED member read (`this.type.keyword`) whose
// intermediate is a purely-`undefined`-typed dynamic read fell through to the
// terminal "unresolvable" fallback in compilePropertyAccess and folded to a
// constant `ref.null.extern` (read null), while the SAME read via a local
// (`var t = this.type; t.keyword`) worked (Bug 2a gave the local an externref
// slot). Fixed by admitting such receivers into the dynamic `__extern_get` arm
// via the shared `undefinedTypedMemberReadProducesExternref` predicate.
//
// NOTE: the exact checker collapse (`this.type` typed PURELY `undefined`)
// needs acorn's scale (heterogeneous `type` fields across dozens of shapes) —
// minimal repros compile through other paths (verified; same finding as the
// two prior slices). These are behavioral no-regression guards; the acorn-
// scale gate is the dogfood harness fixture
// tests/dogfood/fixtures/inputs/member-keyword-props.js (pnpm run dogfood:acorn).
describe("#3033 Bug 2b — chained member reads and keyword-named properties", () => {
  // The acorn parseIdentNode shape: direct chained read must equal the
  // via-local read (pre-fix at acorn scale: null vs "var").
  it("direct chained this.type.keyword equals the via-local read", async () => {
    const exp = await run(`
var TokenType = function TokenType(label, conf) {
  if (conf === void 0) conf = {};
  this.label = label;
  this.keyword = conf.keyword;
};
var keywords = { var: new TokenType("var", { keyword: "var" }) };
var Parser = function Parser() { this.type = keywords.var; };
var pp = Parser.prototype;
pp.readDirect = function () { return this.type.keyword; };
pp.readVia = function () { var t = this.type; return t.keyword; };
export function test() {
  var p = new Parser();
  return String(p.readDirect()) + "|" + String(p.readVia());
}
`);
    expect(exp.test()).toBe("var|var");
  });

  // Reserved words as property names on user objects (`this.var = []`) —
  // the source-level twin of the acorn `x.var` snippet.
  it("keyword-named properties (var/if/function) read and write correctly", async () => {
    const exp = await run(`
var S = function S(f) { this.var = [f]; this.if = "yes"; this.function = 2; };
export function test() {
  var s = new S(7);
  return String(s.var.length) + "|" + String(s.var[0]) + "|" + s.if + "|" + String(s.function);
}
`);
    expect(exp.test()).toBe("1|7|yes|2");
  });

  // Deep chained reads through dynamically-typed receivers stay intact.
  it("deep chained reads through untyped receivers", async () => {
    const exp = await run(`
var make = function () { return { a: { b: { c: "deep" } } }; };
export function test() {
  var o = make();
  return String(o.a.b.c);
}
`);
    expect(exp.test()).toBe("deep");
  });
});
