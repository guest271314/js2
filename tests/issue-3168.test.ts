// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3168 — IR lowering of unary `+` / `-` ToNumber on non-number operands.
//
// `src/ir/from-ast.ts` `lowerPrefixUnary` threw `unary '+' expects number` /
// `unary '-' expects number` for a string- or boolean-typed operand — a legacy
// demote under the overlay, a HARD compile error under the #3143 IR-first flip.
// #3153's post-claim census ranks it class 3 (`+str` / `+bool` are common).
//
// Fix (§13.5.4 Unary Plus IS ToNumber; §13.5.5 Unary Minus is `-ToNumber(x)`;
// §7.1.4 ToNumber): boolean → f64.convert_i32_s; string → box into the boxed-
// any carrier + reuse dyn.to_number (§7.1.4.1 StringToNumber). `-x` negates via
// f64.neg (sign-correct for `-0`, `-"" === -0`).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "issue-3168.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const leaked = WebAssembly.Module.imports(mod).filter((i) => i.module === "env");
  expect(
    leaked.map((i) => i.name),
    "no host imports leaked in standalone",
  ).toEqual([]);
  const inst = await WebAssembly.instantiate(mod, {});
  return (inst.exports as { test(): number }).test();
}

async function runHost(src: string): Promise<number> {
  const r = await compile(src, { fileName: "issue-3168.ts" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = buildImports((r as unknown as { imports: unknown[] }).imports ?? [], undefined, r.stringPool);
  const inst = await WebAssembly.instantiate(mod, imports as unknown as WebAssembly.Imports);
  (imports as { setExports?: (e: Record<string, Function>) => void }).setExports?.(
    inst.exports as Record<string, Function>,
  );
  return (inst.exports as { test(): number }).test();
}

function bothLanes(name: string, src: string, expected: number) {
  it(`${name} (standalone)`, async () => expect(await runStandalone(src)).toBe(expected));
  it(`${name} (host)`, async () => expect(await runHost(src)).toBe(expected));
}

describe("#3168 — IR unary +/- ToNumber", () => {
  bothLanes("+string parses digits", `export function test(): number { const s="42"; return +s; }`, 42);
  bothLanes("+empty string is 0", `export function test(): number { const s=""; return +s; }`, 0);
  bothLanes("+whitespace-trimmed", `export function test(): number { const s=" 42 "; return +s; }`, 42);
  bothLanes("+hex string", `export function test(): number { const s="0x10"; return +s; }`, 16);
  bothLanes(
    "+non-numeric string is NaN",
    `export function test(): number { const s="abc"; const n=+s; return n !== n ? 1 : 0; }`,
    1,
  );
  bothLanes("-string negates ToNumber", `export function test(): number { const s="42"; return -s; }`, -42);
  bothLanes(
    "-empty string is -0 (sign-correct)",
    `export function test(): number { const s=""; const n=-s; return 1 / n === -Infinity ? 1 : 0; }`,
    1,
  );
  bothLanes("+true is 1", `export function test(): number { const b=true; return +b; }`, 1);
  bothLanes("+false is 0", `export function test(): number { const b=false; return +b; }`, 0);
  bothLanes("-true is -1", `export function test(): number { const b=true; return -b; }`, -1);
  bothLanes(
    "+string across a function boundary",
    `function f(s: string): number { return +s; } export function test(): number { return f("7"); }`,
    7,
  );
  bothLanes("+string composes with numeric add", `export function test(): number { const s="3"; return +s + 4; }`, 7);
  bothLanes(
    "numeric operand unchanged (fast path)",
    `export function test(): number { const n = 5.5; return +n + -n; }`,
    0,
  );
});
