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
];

describe("#6775 ES2015 standalone built-ins misc residue", () => {
  for (const p of PROBES) {
    it(`${p.name}: ${p.what}`, { timeout: 120_000 }, async () => {
      expect(await run(p.source)).toBe(p.expected);
    });
  }
});
