// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6775 — ES2015 standalone built-ins misc residue: one pin per implemented
// step of the plan (`plan/issues/6775-es2015-standalone-builtins-misc-residue.md`).
// Each probe asserts the spec answer; every probe FAILS on the base sources
// (before-state recorded in the issue file). Probe sources live in
// `.tmp/6775/pins/` during development and are inlined here.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<number> {
  const r = await compile(source, {
    target: "standalone",
    fileName: "p.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  } as Parameters<typeof compile>[1]);
  const { instance } = await WebAssembly.instantiate(
    r.binary,
    (r as { importObject?: WebAssembly.Imports }).importObject ?? {},
  );
  const ex = instance.exports as { __module_init?: () => void; readResult: () => number };
  ex.__module_init?.();
  return ex.readResult();
}

const PROBES: { name: string; what: string; expected: number; source: string }[] = [
  {
    name: "s1",
    what: "S1 \u2014 get Error.prototype.stack answers undefined for a Proxy / plain receiver; a dynamic stack read reaches the accessor",
    expected: 7,
    source:
      "var __r = 0;\nvar get = Object.getOwnPropertyDescriptor(Error.prototype, 'stack').get;\nif (get.call(new Proxy(new Error('inner'), {})) === undefined) __r |= 1;\nif (get.call({}) === undefined) __r |= 2;\nif (Reflect.get(new Error('x'), 'stack', {}) === undefined) __r |= 4;\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s2",
    what: "S2 \u2014 the stack setter on a Proxy receiver: gOPD undefined takes CreateDataProperty, own stack takes [[Set]]; trap throw/false propagate",
    expected: 15,
    source:
      "var __r = 0;\nvar set = Object.getOwnPropertyDescriptor(Error.prototype, 'stack').set;\nvar log = [];\nvar pE = new Proxy({ stack: 'old' }, {\n  getOwnPropertyDescriptor: function (t, k) { log.push('g'); return Object.getOwnPropertyDescriptor(t, k); },\n  set: function (t, k, v) { log.push('s'); t[k] = v; return true; },\n  defineProperty: function (t, k, d) { log.push('d'); return Reflect.defineProperty(t, k, d); } });\nset.call(pE, 'new');\nif (log.join() === 'g,s') __r |= 1;\nvar log2 = [];\nvar p1 = new Proxy({}, {\n  getOwnPropertyDescriptor: function (t, k) { log2.push('g'); return Object.getOwnPropertyDescriptor(t, k); },\n  defineProperty: function (t, k, d) { log2.push('d'); return Reflect.defineProperty(t, k, d); },\n  set: function () { log2.push('S'); return true; } });\nset.call(p1, 'x');\nif (log2.join() === 'g,d') __r |= 2;\nvar pC = new Proxy({ stack: 'old' }, { set: function () { throw 7; } });\ntry { set.call(pC, 'v'); } catch (x) { if (x === 7) __r |= 4; }\nvar pB = new Proxy({ stack: 'old' }, { set: function () { return false; } });\ntry { set.call(pB, 'v'); } catch (x) { if (x instanceof TypeError) __r |= 8; }\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s3",
    what: "S3 \u2014 new on the stack getter (a descriptor accessor) throws TypeError",
    expected: 31,
    source:
      "var __r = 0;\nvar get = Object.getOwnPropertyDescriptor(Error.prototype, 'stack').get;\nif (typeof get === 'function') __r |= 1;\ntry { new get(); } catch (e) { __r |= 2; if (e instanceof TypeError) __r |= 4; }\nvar f = function () { new get(); };\ntry { f(); } catch (e) { __r |= 8; if (e instanceof TypeError) __r |= 16; }\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s4a",
    what: "S4 \u2014 JSON.parse ToString of a non-string primitive; a JSON boolean is a boolean; a direct `JSON.parse(x) === v` compare",
    expected: 677202,
    source:
      "var __r = 0;\ntry { JSON.parse(); __r |= 1; } catch (e) { if (e instanceof SyntaxError) __r |= 2; else __r |= 4; }\ntry { JSON.parse(undefined); __r |= 8; } catch (e) { if (e instanceof SyntaxError) __r |= 16; else __r |= 32; }\ntry { if (JSON.parse(null) === null) __r |= 64; } catch (e) { __r |= 128; }\ntry { if (JSON.parse(false) === false) __r |= 256; } catch (e) { __r |= 512; }\ntry { if (JSON.parse(true) === true) __r |= 1024; } catch (e) { __r |= 2048; }\ntry { if (JSON.parse(0) === 0) __r |= 4096; } catch (e) { __r |= 8192; }\ntry { if (JSON.parse(3.14) === 3.14) __r |= 16384; } catch (e) { __r |= 32768; }\ntry { JSON.parse(Symbol('desc')); __r |= 65536; } catch (e) { if (e instanceof TypeError) __r |= 131072; else __r |= 262144; }\ntry { if (JSON.parse('1') === 1) __r |= 524288; } catch (e) { __r |= 1048576; }\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s4b",
    what: "S4 \u2014 a provably non-callable, non-array replacer ('' / 0 / true / Symbol()) is ignored",
    expected: 1361,
    source:
      "var __r = 0;\nvar obj = { key: [1] };\nvar json = '{\"key\":[1]}';\nfunction id(x) { return x; }\ntry { if (JSON.stringify(obj, null) === json) __r |= 1; } catch (e) { __r |= 2; }\ntry { if (JSON.stringify(obj, '') === json) __r |= 16; } catch (e) { __r |= 32; }\ntry { if (JSON.stringify(obj, 0) === json) __r |= 64; } catch (e) { __r |= 128; }\ntry { if (JSON.stringify(obj, true) === json) __r |= 256; } catch (e) { __r |= 512; }\ntry { if (JSON.stringify(obj, Symbol()) === json) __r |= 1024; } catch (e) { __r |= 2048; }\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s4c",
    what: "S4 \u2014 a Proxy value whose length trap throws is observed inside the try (no struct copy at the binding)",
    expected: 2,
    source:
      "var __r = 0;\nfunction T262() {}\nvar abruptLength = new Proxy([], { get: function (_t, key) { if (key === 'length') throw new T262(); } });\ntry { JSON.stringify(abruptLength); __r |= 1; } catch (e) { if (e instanceof T262) __r |= 2; else __r |= 4; }\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s4d",
    what: "S4 \u2014 a Proxy replacer is classified before a primitive root is serialised",
    expected: 18,
    source:
      "var __r = 0;\nfunction T262() {}\nvar abruptLength = new Proxy([], { get: function (_t, key) { if (key === 'length') throw new T262(); } });\ntry { JSON.stringify(null, abruptLength); __r |= 1; } catch (e) { if (e instanceof T262) __r |= 2; else __r |= 4; }\nvar abruptToPrimitive = { valueOf: function () { throw new T262(); } };\nvar abruptToLength = new Proxy([], { get: function (_t, key) { if (key === 'length') return abruptToPrimitive; } });\ntry { JSON.stringify([], abruptToLength); __r |= 8; } catch (e) { if (e instanceof T262) __r |= 16; else __r |= 32; }\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s5a",
    what: "S5 \u2014 Symbol.for applies ToString (ToPrimitive \u2192 user toString, Symbol \u2192 TypeError)",
    expected: 1321,
    source:
      "var __r = 0;\ntry { if (Symbol.for('k') === Symbol.for('k')) __r |= 1; } catch (e) { __r |= 2; }\ntry { var subject = { toString: function () { throw new RangeError('t'); } }; Symbol.for(subject); __r |= 4; } catch (e) { if (e instanceof RangeError) __r |= 8; else __r |= 16; }\ntry { var s2 = { toString: function () { return 'k'; } }; if (Symbol.for(s2) === Symbol.for('k')) __r |= 32; } catch (e) { __r |= 64; }\ntry { Symbol.for(Symbol('s')); __r |= 128; } catch (e) { if (e instanceof TypeError) __r |= 256; else __r |= 512; }\ntry { if (Symbol.keyFor(Symbol.for(1)) === '1') __r |= 1024; } catch (e) { __r |= 2048; }\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s5b",
    what: "S5 \u2014 sym() / new Object(sym)() throw TypeError; Object(sym) inherits from Symbol.prototype",
    expected: 873618,
    source:
      "var __r = 0;\nvar sym = Symbol('desc');\ntry { sym(); __r |= 1; } catch (e) { if (e instanceof TypeError) __r |= 2; else __r |= 4; }\ntry { new sym(); __r |= 8; } catch (e) { if (e instanceof TypeError) __r |= 16; else __r |= 32; }\nvar symObj = Object(Symbol());\ntry { symObj(); __r |= 64; } catch (e) { if (e instanceof TypeError) __r |= 128; else __r |= 256; }\ntry { new symObj(); __r |= 512; } catch (e) { if (e instanceof TypeError) __r |= 1024; else __r |= 2048; }\ntry { if (Object.getPrototypeOf(Symbol('66')).constructor === Symbol) __r |= 4096; } catch (e) { __r |= 8192; }\ntry { if (Object.getPrototypeOf(Object(Symbol('66'))).constructor === Symbol) __r |= 16384; } catch (e) { __r |= 32768; }\ntry { if (Object.getPrototypeOf(Object(Symbol('66'))) === Symbol.prototype) __r |= 65536; } catch (e) { __r |= 131072; }\ntry { var p = Object.getPrototypeOf(Symbol('66')); if (p === Symbol.prototype) __r |= 262144; if (p.constructor === Symbol) __r |= 524288; } catch (e) { __r |= 1048576; }\nexport function readResult() { return __r; }\n",
  },
  {
    name: "s5c",
    what: "S5 \u2014 recv[Symbol.toPrimitive]() on a symbol / Symbol wrapper answers the symbol",
    expected: 2901,
    source:
      "var __r = 0;\ntry { if (Object(Symbol.toPrimitive)[Symbol.toPrimitive]() === Symbol.toPrimitive) __r |= 1; } catch (e) { __r |= 2; }\ntry { if (Symbol.toPrimitive[Symbol.toPrimitive]() === Symbol.toPrimitive) __r |= 4; } catch (e) { __r |= 8; }\ntry { var s = Symbol('x'); if (s[Symbol.toPrimitive]() === s) __r |= 16; } catch (e) { __r |= 32; }\ntry { var w = Object(Symbol.iterator); if (w[Symbol.toPrimitive]() === Symbol.iterator) __r |= 64; } catch (e) { __r |= 128; }\ntry { var s3 = Symbol('y'); if (s3.toString() === 'Symbol(y)') __r |= 256; if (s3.valueOf() === s3) __r |= 512; } catch (e) { __r |= 1024; }\ntry { if (Symbol.iterator.description === 'Symbol.iterator') __r |= 2048; } catch (e) { __r |= 4096; }\nexport function readResult() { return __r; }\n",
  },
];

describe("#6775 ES2015 standalone built-ins misc residue", () => {
  for (const p of PROBES) {
    it(`${p.name}: ${p.what}`, { timeout: 120_000 }, async () => {
      expect(await run(p.source)).toBe(p.expected);
    });
  }
});
