// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6772 — ES2015 standalone class residue. One probe per mechanism step, each
// the minimal shape of its test262 row(s). Every "RED on base" case records the
// value `origin/main` @ 08e61b2644 answered and asserts node's answer; every
// guard case asserts an answer base already gave, to hold order preservation.
//
// Probes run standalone (`imports: []`) with the top-level code deferred into
// `__module_init`, then read the module's `__r` accumulator.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runProbe(body: string): Promise<unknown> {
  const source = `var __r = 0;\n${body}\nexport function readResult() { return __r; }\n`;
  const result = await compile(source, {
    target: "standalone",
    fileName: "probe.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  expect(result.imports ?? [], "#6772 probes must stay host-free").toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as { __module_init?: () => void; readResult: () => unknown };
  exports.__module_init?.();
  return exports.readResult();
}

describe("#6772 S1a — super(...) publishes extras to a parent that reads `arguments`", () => {
  it("RED on base (0): the super(1, 2) site into a zero-formal parent (node 2121)", async () => {
    expect(
      await runProbe(`
        var seen = 0;
        class Base { constructor(){ seen = seen * 100 + arguments.length * 10 + (arguments[0] === 1 ? 1 : 0); } }
        class Sub extends Base { constructor(){ super(1, 2); } }
        class Sub2 extends Base { constructor(x, y){ super(1, 2); } }
        new Sub(3, 4);
        new Sub2(3, 4);
        __r = seen;
      `),
    ).toBe(2121);
  });

  it("guard (base 21): the direct new Base(1, 2) site is unchanged", async () => {
    expect(
      await runProbe(`
        var seen = 0;
        class Base { constructor(){ seen = arguments.length * 10 + (arguments[0] === 1 ? 1 : 0); } }
        class Sub extends Base { constructor(){ super(1, 2); } }
        new Base(1, 2);
        __r = seen;
      `),
    ).toBe(21);
  });
});
