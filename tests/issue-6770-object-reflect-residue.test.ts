// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6770 — ES2015 standalone `built-ins/Object/**` + `built-ins/Reflect/**`
// residue. One `it` per mechanism probe from the issue's implementation plan
// (`.tmp/6770/p*.js`, inlined here). Every probe answers a NUMBER bit mask — a
// standalone module's string is a WasmGC array the host cannot decode, so all
// comparisons happen inside the module, and values flow through a
// `sameValue`-shaped function so the checker cannot fold the comparison.
//
// "RED on base" marks a probe that answers differently on `origin/main` @
// a37e18b919 (measured by swapping `.tmp/6770/base-src/src` in); the expected
// value is node's. Guards answer the same on both trees.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function probe(source: string): Promise<number | string> {
  const r = await compile(source, {
    target: "standalone",
    fileName: "p.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  } as never);
  try {
    const { instance } = await WebAssembly.instantiate(r.binary, (r as { importObject?: object }).importObject ?? {});
    const ex = instance.exports as { __module_init?: () => void; readResult: () => number };
    ex.__module_init?.();
    return ex.readResult();
  } catch (e) {
    return `THROW ${String((e as Error)?.message ?? e)}`;
  }
}

const SV = `function sv(a, b) { if (a === b) return a !== 0 || 1 / a === 1 / b; return a !== a && b !== b; }\n`;
const END = `export function readResult() { return __r; }\n`;
const T = 120_000;

describe("#6770 S1 — Object.assign ToObject on every operand", () => {
  it(
    "primitive targets answer their wrapper's valueOf through a call argument (RED on base)",
    async () => {
      const src = `var __r = 0;\n${SV}function ty(x) { return typeof x; }
var r1 = Object.assign("test", { a: 1 }); if (sv(ty(r1), "object")) __r |= 1; if (sv(r1.valueOf(), "test")) __r |= 2;
var r2 = Object.assign(1, { a: 1 }); if (sv(ty(r2), "object")) __r |= 4; if (sv(r2.valueOf(), 1)) __r |= 8;
var r3 = Object.assign(true, { a: 1 }); if (sv(ty(r3), "object")) __r |= 16; if (sv(r3.valueOf(), true)) __r |= 32;
if (sv(ty(r1.valueOf()), "string")) __r |= 64; if (sv(ty(r3.valueOf()), "boolean")) __r |= 128;
if (sv(r1.a, 1)) __r |= 256;\n${END}`;
      expect(await probe(src)).toBe(511);
    },
    T,
  );

  it(
    "p1b — Object.assign(true, {a:1}).valueOf() === true (RED on base)",
    async () => {
      const src = `var __r = 0;
var n = Object.assign(1, { a: 1 }); if (typeof n === "object") __r |= 1; if (n.valueOf() === 1) __r |= 2;
var b = Object.assign(true, { a: 1 }); if (typeof b === "object") __r |= 4; if (b.valueOf() === true) __r |= 8;\n${END}`;
      expect(await probe(src)).toBe(15);
    },
    T,
  );

  it(
    "p1d — primitive string SOURCES copy their index keys onto a Number wrapper (RED on base)",
    async () => {
      const src = `var __r = 0;
var t = Object.assign(12, "aaa", "bb2b", "1c");
if (typeof t === "object") __r |= 1;
if (Object.getOwnPropertyNames(t).length === 4) __r |= 2;
if (t[0] === "1" && t[3] === "b") __r |= 4;\n${END}`;
      expect(await probe(src)).toBe(7);
    },
    T,
  );

  it(
    "p1f/p1g — string and String-wrapper sources onto a plain target, bound then indexed (RED on base)",
    async () => {
      const src = `var __r = 0;\n${SV}
var t2 = Object.assign({}, "ab"); if (sv(t2[0], "a") && sv(t2[1], "b")) __r |= 1;
if (sv(Object.keys(t2).length, 2)) __r |= 2;
var t3 = Object.assign({}, new String("cd")); if (sv(t3[0], "c")) __r |= 4;
var t4 = Object.assign({}, 5, true, null, undefined); if (sv(Object.keys(t4).length, 0)) __r |= 8;\n${END}`;
      expect(await probe(src)).toBe(15);
    },
    T,
  );

  it(
    "guard — object operands keep the target identity",
    async () => {
      const src = `var __r = 0;\n${SV}
var t = { a: 1 }; var r = Object.assign(t, { b: 2 }); if (sv(r, t)) __r |= 1; if (sv(r.b, 2)) __r |= 2;
if (sv(Object.keys({ a: 1, b: 2 }).join(), "a,b")) __r |= 4;\n${END}`;
      expect(await probe(src)).toBe(7);
    },
    T,
  );
});

describe("#6770 S2 — a literal written through a reflective builtin is an open $Object", () => {
  it(
    "Object.assign / Reflect.set / Reflect.deleteProperty on a literal-bound var (RED on base)",
    async () => {
      const src = `var __r = 0;\n${SV}
var target = { a: 1 }; var result = Object.assign(target, { a: 2 }, { a: "c" }); if (sv(result.a, "c")) __r |= 1;
var o1 = { p: 43 }; var res = Reflect.set(o1, "p", 42); if (sv(res, true)) __r |= 2; if (sv(o1.p, 42)) __r |= 4;
var o2 = { p: 43 }; var receiver = { p: 44 }; var res = Reflect.set(o2, "p", 42, receiver);
if (sv(res, true)) __r |= 8; if (sv(o2.p, 43)) __r |= 16; if (sv(receiver.p, 42)) __r |= 32;
var o3 = { prop: 42 }; Reflect.deleteProperty(o3, "prop"); if (sv(o3.hasOwnProperty("prop"), false)) __r |= 64;\n${END}`;
      expect(await probe(src)).toBe(127);
    },
    T,
  );

  it(
    "inline literals under freeze / preventExtensions keep integrity and accessors (RED on base)",
    async () => {
      const src = `var __r = 0;\n${SV}
var target2 = Object.freeze({ foo: 1 });
try { Object.assign(target2, { foo: 1 }); } catch (e) { if (e instanceof TypeError) __r |= 1; }
if (sv(target2.foo, 1)) __r |= 2;
if (sv(Object.isFrozen(target2), true)) __r |= 4;
var value1 = 1;
var target1 = Object.preventExtensions({ set foo(val) { value1 = val; } });
Object.assign(target1, { foo: 2 }); if (sv(value1, 2)) __r |= 8;
var f3 = Object.freeze({ foo: 1 }); Reflect.set(f3, "foo", 2); if (sv(f3.foo, 1)) __r |= 16;\n${END}`;
      expect(await probe(src)).toBe(31);
    },
    T,
  );

  it(
    "Object.entries keeps a symbol VALUE's identity on both carriers (RED on base)",
    async () => {
      const src = `var __r = 0;\n${SV}
var symValue = Symbol("value"); var enumSym = Symbol("enum");
var obj3 = { key: symValue, n: 1 }; if (sv(Object.entries(obj3)[0][1], symValue)) __r |= 1;
var obj4 = { key: symValue };
Object.defineProperty(obj4, enumSym, { enumerable: false, value: 1 });
var e4 = Object.entries(obj4); if (sv(e4[0][1], symValue)) __r |= 2; if (sv(e4.length, 1)) __r |= 4;\n${END}`;
      expect(await probe(src)).toBe(7);
    },
    T,
  );

  it(
    "guard — a plain literal only READ reflectively, or frozen by name, keeps working",
    async () => {
      const src = `var __r = 0;\n${SV}
var o = { a: 1, b: 2 }; if (sv(Object.keys(o).join(), "a,b")) __r |= 1;
if (sv(Object.getOwnPropertyDescriptor(o, "a").value, 1)) __r |= 2;
if (sv(Reflect.get(o, "b"), 2)) __r |= 4;
var f = { x: 1 }; Object.freeze(f); if (sv(Object.isFrozen(f), true)) __r |= 8;
if (sv(Object.prototype.toString.call([]), "[object Array]")) __r |= 16;\n${END}`;
      expect(await probe(src)).toBe(31);
    },
    T,
  );
});

const EQ = `function eq(a, b) { if (a.length !== b.length) return false; for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }\n`;

describe("#6770 S3 — own-key ORDER (§10.1.11.1, §10.4.3.6, function intrinsics)", () => {
  it(
    "array indices up to 2^32-2 sort first; 2^32-1 keeps its insertion slot (RED on base)",
    async () => {
      const src = `var __r = 0;\n${EQ}
var o5 = {}; o5[4294967295] = 1; o5[4294967294] = 1; o5[1] = 1;
if (eq(Reflect.ownKeys(o5), ["1", "4294967294", "4294967295"])) __r |= 1;
var o2 = {}; o2[12345678900] = 1; o2.b = 1; o2[4294967294] = 1;
if (eq(Reflect.ownKeys(o2), ["4294967294", "12345678900", "b"])) __r |= 2;
var o3 = { b: 1, 2: 1, a: 1, 1: 1 };
if (eq(Reflect.ownKeys(o3), ["1", "2", "b", "a"])) __r |= 4;
if (eq(Object.keys(o3), ["1", "2", "b", "a"])) __r |= 8;\n${END}`;
      expect(await probe(src)).toBe(15);
    },
    T,
  );

  it(
    "String wrapper length precedes expandos; RegExp owns lastIndex (RED on base)",
    async () => {
      const src = `var __r = 0;\n${EQ}
var s = new String("ab"); s.z = 1; if (eq(Reflect.ownKeys(s), ["0", "1", "length", "z"])) __r |= 1;
var st = new String(""); st.a = 1; st.b = 2; if (eq(Reflect.ownKeys(st), ["length", "a", "b"])) __r |= 2;
var s5 = new String("xy"); s5[5] = "i"; if (eq(Object.getOwnPropertyNames(s5), ["0", "1", "5", "length"])) __r |= 4;
var re = /x/g; re.a = 1; if (eq(Reflect.ownKeys(re), ["lastIndex", "a"])) __r |= 8;
var d = Object.getOwnPropertyDescriptor(re, "lastIndex");
if (d !== undefined && d.value === 0 && d.writable === true && d.enumerable === false && d.configurable === false) __r |= 16;
Object.defineProperty(re, "lastIndex", { value: 2 });
if (eq(Reflect.ownKeys(Object.getOwnPropertyDescriptors(re)), ["lastIndex", "a"])) __r |= 32;
if (eq(Object.keys(re), ["a"])) __r |= 64;\n${END}`;
      expect(await probe(src)).toBe(127);
    },
    T,
  );

  it(
    "a function's redefined length/name lead its expandos; entries/values see them (RED on base)",
    async () => {
      const src = `var __r = 0;\n${EQ}
var fn = () => {}; fn.a = 1; Object.defineProperty(fn, "length", { enumerable: true });
if (eq(Object.keys(fn), ["length", "a"])) __r |= 1;
if (eq(Object.getOwnPropertyNames(fn), ["length", "name", "a"])) __r |= 2;
var fn2 = () => {}; fn2.a = 1; Object.defineProperty(fn2, "name", { enumerable: true });
if (eq(Object.entries(fn2).map(function (e) { return e[0]; }), ["name", "a"])) __r |= 4;
var fn3 = () => {}; fn3.a = 1;
if (Object.entries(fn3).length === 1 && Object.values(fn3)[0] === 1) __r |= 8;
var o = {}; o.name = 1; o.length = 2; if (eq(Object.keys(o), ["name", "length"])) __r |= 16;\n${END}`;
      expect(await probe(src)).toBe(31);
    },
    T,
  );
});

describe("#6770 S4 — Reflect residue", () => {
  it(
    "Reflect.setPrototypeOf answers false on a non-extensible target, even for a fresh {} (RED on base)",
    async () => {
      const src = `var __r = 0;\n${SV}
var o1 = {}; Object.preventExtensions(o1);
if (sv(Reflect.setPrototypeOf(o1, {}), false)) __r |= 1;
if (sv(Object.getPrototypeOf(o1), Object.prototype)) __r |= 2;
var fresh = Object.create({ tag: 1 }); if (sv(Object.getPrototypeOf(fresh).tag, 1)) __r |= 4;
var p = {}; var c = Object.create(p); if (sv(Object.getPrototypeOf(c), p)) __r |= 8;\n${END}`;
      expect(await probe(src)).toBe(15);
    },
    T,
  );

  it(
    "Reflect.defineProperty returns false for a rejected define, rethrows everything else (RED on base)",
    async () => {
      const src = `var __r = 0;\n${SV}
var o = {}; o.p1 = "foo";
if (sv(Reflect.defineProperty(o, "p1", {}), true)) __r |= 1;
if (sv(Reflect.defineProperty(o, "p2", { value: 42 }), true)) __r |= 2;
Object.freeze(o);
if (sv(Reflect.defineProperty(o, "p2", { value: 43 }), false)) __r |= 4;
if (sv(o.p2, 42)) __r |= 8;
if (sv(Reflect.defineProperty(o, "p4", { value: 1 }), false)) __r |= 16;
var threw = 0; try { Object.defineProperty(o, "p5", { value: 1 }); } catch (e) { if (e instanceof TypeError) threw = 1; }
if (threw) __r |= 32;
var d = {}; Object.defineProperty(d, "value", { get: function () { throw new RangeError("x"); } });
var kind = 0; try { Reflect.defineProperty({}, "q", d); } catch (e) { kind = e instanceof RangeError ? 1 : 2; }
if (sv(kind, 1)) __r |= 64;\n${END}`;
      expect(await probe(src)).toBe(127);
    },
    T,
  );

  it(
    "Reflect's Object.prototype members are ordinary method calls (compile refusal on base)",
    async () => {
      const src = `var __r = 0;
if (Reflect.enumerate === undefined) __r |= 1;
if (Reflect.hasOwnProperty("enumerate") === false) __r |= 2;
if (Reflect.hasOwnProperty("ownKeys") === true) __r |= 4;\n${END}`;
      expect(await probe(src)).toBe(7);
    },
    T,
  );
});

describe("#6770 S5 — Object.prototype members: __proto__ own-ness, the literal getPrototypeOf fold, toLocaleString", () => {
  it(
    "Object.prototype.__proto__ is an own configurable accessor on every own-property surface (RED on base)",
    async () => {
      const src = `var __r = 0;\n${SV}
var desc = Object.getOwnPropertyDescriptor(Object.prototype, "__proto__");
if (sv(typeof desc.get, "function") && sv(typeof desc.set, "function")) __r |= 1;
if (sv(desc.enumerable, false) && sv(desc.configurable, true)) __r |= 2;
if (sv(Object.prototype.hasOwnProperty("__proto__"), true)) __r |= 4;
if (Object.getOwnPropertyNames(Object.prototype).indexOf("__proto__") >= 0) __r |= 8;
if (sv("__proto__" in Object.prototype, true)) __r |= 16;
if (sv(Object.prototype.propertyIsEnumerable("__proto__"), false)) __r |= 32;
if (sv(Object.prototype.hasOwnProperty("toString"), true)) __r |= 64;\n${END}`;
      expect(await probe(src)).toBe(127);
    },
    T,
  );

  it(
    "Object.getPrototypeOf(<{} binding>) sees a reflective / Annex B prototype write (RED on base)",
    async () => {
      const src = `var __r = 0;\n${SV}
var set = Object.getOwnPropertyDescriptor(Object.prototype, "__proto__").set;
var proto = {}; var subject = {};
set.call(subject, proto);
if (sv(Object.getPrototypeOf(subject), proto)) __r |= 1;
if (sv(proto.isPrototypeOf(subject), true)) __r |= 2;
var subject2 = {}; Object.setPrototypeOf(subject2, proto);
if (sv(Object.getPrototypeOf(subject2), proto)) __r |= 4;
var subject3 = {}; subject3.__proto__ = proto;
if (sv(Object.getPrototypeOf(subject3), proto)) __r |= 8;
var plain = {}; if (sv(Object.getPrototypeOf(plain), Object.prototype)) __r |= 16;\n${END}`;
      expect(await probe(src)).toBe(31);
    },
    T,
  );

  it(
    "toLocaleString on a primitive this is Invoke(O, 'toString') with the primitive receiver (RED on base)",
    async () => {
      const src = `"use strict";\nvar __r = 0;\n${SV}
var f = function () { return typeof this; };
Boolean.prototype.toString = f;
if (sv(Boolean.prototype.toString, f)) __r |= 1;
if (sv(true.toString(), "boolean")) __r |= 2;
if (sv(true.toLocaleString(), "boolean")) __r |= 4;
if (sv(Object.prototype.toLocaleString.call(true), "boolean")) __r |= 8;
function h(v) { return v.toString(); } if (sv(h(true), "boolean")) __r |= 16;
Object.defineProperty(Number.prototype, "toString", { get: function () { var v = typeof this; return function () { return v; }; } });
if (sv(Object.prototype.toLocaleString.call(5), "number")) __r |= 32;
var o = { toString: function () { return "o!"; } }; if (sv(o.toLocaleString(), "o!")) __r |= 64;\n${END}`;
      expect(await probe(src)).toBe(127);
    },
    T,
  );
});

describe("#6770 S6 — Object.prototype.toString tags (§20.1.3.6 steps 3-15)", () => {
  it(
    "the METHOD spelling o.toString() reads @@toStringTag (RED on base)",
    async () => {
      const src = `var __r = 0;\n${SV}
var poisoned = Object.defineProperty({}, Symbol.toStringTag, { get: function () { throw new Error("x"); } });
try { poisoned.toString(); } catch (e) { __r |= 1; }
var custom = {}; custom[Symbol.toStringTag] = "c";
if (sv(custom.toString(), "[object c]")) __r |= 2;
var plain = {}; if (sv(plain.toString(), "[object Object]")) __r |= 4;
var own = {}; own.toString = function () { return "own"; }; own[Symbol.toStringTag] = "zz";
if (sv(own.toString(), "own")) __r |= 8;\n${END}`;
      expect(await probe(src)).toBe(15);
    },
    T,
  );

  it(
    "builtinTag (IsArray) is settled before a get trap revokes the proxy (RED on base)",
    async () => {
      const src = `var __r = 0;\n${SV}
var h1 = Proxy.revocable([], { get: function () { h1.revoke(); } });
try { if (sv(Object.prototype.toString.call(h1.proxy), "[object Array]")) __r |= 1; } catch (e) { __r |= 2; }
var h2 = Proxy.revocable({}, { get: function () { h2.revoke(); } });
var outer = new Proxy(h2.proxy, {});
try { if (sv(Object.prototype.toString.call(outer), "[object Object]")) __r |= 4; } catch (e) { __r |= 8; }
var h3 = Proxy.revocable([], { get: function () { h3.revoke(); } });
try { if (h3.proxy.foo === undefined) __r |= 16; } catch (e) { __r |= 32; }\n${END}`;
      expect(await probe(src)).toBe(21);
    },
    T,
  );

  it(
    "a deleted WeakSet / WeakMap / Promise prototype tag answers [object Object] (RED on base)",
    async () => {
      const src = `var __r = 0;\n${SV}
var toString = Object.prototype.toString;
var ws = new WeakSet(), wm = new WeakMap(), p = new Promise(function () {});
if (sv(toString.call(ws), "[object WeakSet]")) __r |= 1;
if (sv(toString.call(wm), "[object WeakMap]")) __r |= 2;
if (sv(toString.call(p), "[object Promise]")) __r |= 4;
delete WeakSet.prototype[Symbol.toStringTag]; if (sv(toString.call(ws), "[object Object]")) __r |= 8;
delete WeakMap.prototype[Symbol.toStringTag]; if (sv(toString.call(wm), "[object Object]")) __r |= 16;
delete Promise.prototype[Symbol.toStringTag]; if (sv(toString.call(p), "[object Object]")) __r |= 32;
if (sv(toString.call(new Map()), "[object Map]")) __r |= 64;\n${END}`;
      expect(await probe(src)).toBe(127);
    },
    T,
  );
});

describe("#6770 S7 — Proxy [[OwnPropertyKeys]] surfaces", () => {
  it(
    "every own-key surface of a proxy reads ONE validated list and takes its part (RED on base)",
    async () => {
      const src = `var __r = 0;
var t1 = {}; Object.defineProperty(t1, "prop", { value: 1, writable: true, enumerable: true, configurable: false });
var p1 = new Proxy(t1, { ownKeys: function () { return []; } });
try { Object.getOwnPropertySymbols(p1); } catch (e) { if (e instanceof TypeError) __r |= 1; }
try { Object.getOwnPropertyNames(p1); } catch (e) { if (e instanceof TypeError) __r |= 2; }
var p2 = new Proxy({}, { ownKeys: function () { return ["a", "a"]; } });
try { Object.getOwnPropertySymbols(p2); } catch (e) { if (e instanceof TypeError) __r |= 4; }
var t3 = {}; Object.defineProperty(t3, "prop", { value: 3, writable: true, enumerable: false, configurable: true });
var p3 = new Proxy(t3, { ownKeys: function () { return ["prop"]; } }); Object.preventExtensions(t3);
if (Object.keys(p3).length === 0) __r |= 8;
var t4 = {}; var sym = Symbol(); t4[sym] = 1; t4.foo = 2; t4[0] = 3; var seen = [];
var p4 = new Proxy(t4, { getOwnPropertyDescriptor: function (_t, key) { seen.push(key); } });
Object.getOwnPropertyDescriptors(p4);
if (seen.length === 3 && seen[0] === "0" && seen[1] === "foo" && seen[2] === sym) __r |= 16;
if (Reflect.ownKeys(p4).length === 3) __r |= 32;
var p5 = new Proxy({}, { getOwnPropertyDescriptor: function () {}, ownKeys: function () { return ["a"]; } });
if (!("a" in Object.getOwnPropertyDescriptors(p5))) __r |= 64;
var t6 = {}; var s6 = Symbol(); Object.defineProperty(t6, s6, { value: 1, configurable: false });
var p6 = new Proxy(t6, { ownKeys: function () { return []; } });
try { Object.getOwnPropertyNames(p6); } catch (e) { if (e instanceof TypeError) __r |= 128; }
var names = Object.getOwnPropertyNames(new Proxy(t4, {}));
if (names.length === 2 && names[0] === "0" && names[1] === "foo") __r |= 256;
var syms = Object.getOwnPropertySymbols(new Proxy(t4, {}));
if (syms.length === 1 && syms[0] === sym) __r |= 512;\n${END}`;
      expect(await probe(src)).toBe(1023);
    },
    T,
  );

  it(
    "defineProperties / seal / freeze / isPrototypeOf through a proxy (RED on base)",
    async () => {
      const src = `var __r = 0;
var sym = Symbol(); var t = {}; t[sym] = 1; t.foo = 2; t[0] = 3; var order = [];
var bag = new Proxy(t, { getOwnPropertyDescriptor: function (_t, key) { order.push(key); } });
Object.defineProperties({}, bag);
if (order.length === 3 && order[0] === "0" && order[1] === "foo" && order[2] === sym) __r |= 1;
var seen = {}; var keys = [];
var p = new Proxy({ [sym]: 1, get foo() {}, set foo(_v) {} }, {
  defineProperty: function (tt, key, d) { keys.push(key); seen[key] = d; return Reflect.defineProperty(tt, key, d); },
});
Object.seal(p);
if (keys.length === 2) __r |= 2;
if (seen[sym] && seen[sym].configurable === false && seen[sym].value === undefined) __r |= 4;
if (seen.foo && seen.foo.configurable === false && seen.foo.get === undefined) __r |= 8;
var proxyProto = []; var p6 = new Proxy({}, { getPrototypeOf: function () { return proxyProto; } });
if (proxyProto.isPrototypeOf(p6)) __r |= 16;
if (!({}).isPrototypeOf(p6)) __r |= 32;
if (Object.prototype.isPrototypeOf(p6)) __r |= 64;\n${END}`;
      expect(await probe(src)).toBe(127);
    },
    T,
  );

  it(
    "guard — ordinary own-key surfaces keep their answers",
    async () => {
      const src = `var __r = 0;
var s = Symbol(); var o = {}; o.b = 1; o.a = 2; o[1] = 5; o[s] = 3;
var n = Object.getOwnPropertyNames(o); if (n.length === 3 && n[0] === "1" && n[1] === "b" && n[2] === "a") __r |= 1;
var y = Object.getOwnPropertySymbols(o); if (y.length === 1 && y[0] === s) __r |= 2;
var k = Reflect.ownKeys(o); if (k.length === 4 && k[3] === s) __r |= 4;
if (Object.keys(o).join() === "1,b,a") __r |= 8;\n${END}`;
      expect(await probe(src)).toBe(15);
    },
    T,
  );

  it(
    "nested proxies, non-$Object targets, and the Object.keys gopd filter (RED on base)",
    async () => {
      // for-in over a proxy is NOT asserted: it misses on base and branch alike.
      const src = `var __r = 0;
var sym = Symbol(); var t4 = {}; t4[sym] = 1; t4.foo = 2; t4[0] = 3;
var k1 = Reflect.ownKeys(new Proxy(new Proxy(t4, {}), {}));
if (k1.length === 3 && k1[0] === "0" && k1[1] === "foo" && k1[2] === sym) __r |= 1;
var k2 = Object.keys(new Proxy([1, 2], {})); if (k2.length === 2 && k2[0] === "0" && k2[1] === "1") __r |= 2;
var k3 = Object.keys(new Proxy(t4, {})); if (k3.length === 2 && k3[0] === "0" && k3[1] === "foo") __r |= 4;
if (Object.getOwnPropertyNames(new Proxy(new Proxy(t4, {}), {})).length === 2) __r |= 16;
var g2 = Object.getOwnPropertySymbols(new Proxy(new Proxy(t4, {}), {})); if (g2.length === 1 && g2[0] === sym) __r |= 32;
var fn = function () {}; fn.a = 1;
var k4 = Object.keys(new Proxy(fn, {})); if (k4.length === 1 && k4[0] === "a") __r |= 64;
var k5 = Object.keys(new Proxy(new String("ab"), {})); if (k5.length === 2 && k5[0] === "0") __r |= 128;
var cnt = 0;
var p6 = new Proxy({ a: 1, b: 2 }, { getOwnPropertyDescriptor: function (t, k) { cnt++; return Reflect.getOwnPropertyDescriptor(t, k); } });
if (Object.keys(p6).length === 2 && cnt === 2) __r |= 256;
var p7 = new Proxy({}, { ownKeys: function () { return ["x", "y"]; }, getOwnPropertyDescriptor: function (t, k) { return k === "x" ? { value: 1, enumerable: true, configurable: true } : undefined; } });
var k7 = Object.keys(p7); if (k7.length === 1 && k7[0] === "x") __r |= 512;\n${END}`;
      expect(await probe(src)).toBe(1015);
    },
    T,
  );

  it(
    "Object.defineProperties with a closed-struct Properties map from a call (RED on base)",
    async () => {
      const src = `var __r = 0;
function mk() { return { b: { value: 2 } }; }
var o2 = Object.defineProperties({}, mk()); if (o2.b === 2) __r |= 1;
var o3 = {}; Object.defineProperties(o3, mk()); if (o3.b === 2) __r |= 2;
var d = Object.getOwnPropertyDescriptor(o3, "b"); if (d && d.value === 2 && d.writable === false && d.enumerable === false) __r |= 4;
var bag = mk(); var o4 = Object.create(Object.prototype); Object.defineProperties(o4, bag);
if (Object.getOwnPropertyNames(o4).length === 1) __r |= 8;
function mk2() { var r = {}; r.b = { value: 2 }; return r; }
if (Object.getOwnPropertyNames(Object.defineProperties({}, mk2())).length === 1) __r |= 16;\n${END}`;
      expect(await probe(src)).toBe(31);
    },
    T,
  );
});
