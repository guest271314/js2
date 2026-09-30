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
];

describe("#6774 ES2015 standalone expressions residue", () => {
  for (const p of PROBES) {
    it(`${p.step} ${p.name}`, async () => {
      expect(await run(PRELUDE + p.body + EPILOGUE)).toBe(p.expected);
    });
  }
});
