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
