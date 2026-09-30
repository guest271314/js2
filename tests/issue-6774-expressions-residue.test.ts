// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6774 — ES2015 standalone expressions residue: one pin per plan probe
// (`plan/issues/6774-es2015-standalone-expressions-residue.md`). Each probe is a
// strict module whose `main()` returns a bit mask; every case FAILS (wrong mask,
// trap or throw) on the base sources and answers `expected` on the branch.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(source: string): Promise<number> {
  const r = await compile(source, {
    target: "standalone",
    fileName: "p.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
    hostBridge: "always",
  } as Parameters<typeof compile>[1]);
  expect(r.success).toBe(true);
  expect(r.imports.filter((i) => i.module !== "wasm:js-string")).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const ex = instance.exports as { __module_init?: () => void; main: () => number };
  ex.__module_init?.();
  return ex.main();
}

const PRELUDE = `var bits = 0; function sv(a, b) { return a === b; } function ID(x) { return x; }\n`;
const EPILOGUE = `\nexport function main() { return bits; }`;

const PROBES: { name: string; step: string; expected: number; body: string }[] = [
  {
    name: "c1_getter_id",
    step: "S1",
    expected: 1,
    body: `var proto = { m() { return "pm"; } }; var o = { get [ID("b")]() { return "b" + super.m(); } }; Object.setPrototypeOf(o, proto); if (sv(o.b, "bpm")) bits |= 1;`,
  },
  {
    name: "c1_setter_id",
    step: "S1",
    expected: 1,
    body: `var got; var proto = { m(v) { got = v; } }; var o = { set [ID("b")](v) { super.m(v); } }; Object.setPrototypeOf(o, proto); o.b = 7; if (sv(got, 7)) bits |= 1;`,
  },
  {
    name: "k3_own_proto_reads",
    step: "S2",
    expected: 23,
    body: `var obj; var sample = {};
obj = { ['__proto__']: sample }; if (obj.__proto__ === sample) bits |= 1; if (Object.getPrototypeOf(obj) === Object.prototype) bits |= 2;
var sym = Symbol("L"); obj = { ['__proto__']: sym }; if (obj.__proto__ === sym) bits |= 4;
obj = { ['__proto__']: null }; if (obj.__proto__ === null) bits |= 16;`,
  },
  {
    name: "e4_new_tag_ident",
    step: "S3",
    expected: 7,
    body: `function K(x) { arg = x; } var arg = null, tobj; function tag(x) { tobj = x; return K; } var i = new tag\`a\`; if (i instanceof K) bits |= 1; if (sv(tobj[0], "a")) bits |= 2; i = new tag\`b\`("c"); if (sv(arg, "c")) bits |= 4;`,
  },
  {
    name: "a_fn_value",
    step: "S4",
    expected: 7,
    body: `var nt = null; function f() { nt = new.target; } new f(); if (sv(nt, f)) bits |= 1; nt = 1; f(); if (sv(nt, undefined)) bits |= 2; if (typeof nt === "undefined") bits |= 4;`,
  },
  {
    name: "a_cls_chain_value",
    step: "S4",
    expected: 3,
    body: `var pnt, bnt; class B { constructor() { bnt = new.target; } } class P extends B { constructor() { pnt = new.target; super(); } } class C extends P { constructor() { super(); } } new C(); if (sv(pnt, C)) bits |= 1; if (sv(bnt, C)) bits |= 2;`,
  },
  {
    name: "a_arrow_iife_and_closure",
    step: "S4",
    expected: 7,
    body: `var hits = 0; function F() { if ((_ => new.target)() !== undefined) hits++; this.af = _ => (new.target ? 1 : 2); } F(); var o = new F(); if (hits === 1) bits |= 1; if (o.af() === 1) bits |= 2; var gnt; var g = function () { gnt = new.target; }; new g(); if (sv(gnt, g)) { g(); if (sv(gnt, undefined)) bits |= 4; }`,
  },
];

describe("#6774 ES2015 standalone expressions residue", () => {
  for (const p of PROBES) {
    it(`${p.step} ${p.name}`, async () => {
      expect(await run(PRELUDE + p.body + EPILOGUE)).toBe(p.expected);
    });
  }
});
