// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3167 — IR lowering of string relational operators (`<` `>` `<=` `>=`).
//
// `src/ir/from-ast.ts` previously threw `string operator '<' not in slice 1`
// for a string-typed relational, demoting the whole function to legacy (a
// warning under the overlay, a HARD compile error under the #3143 IR-first
// flip — codegen/index.ts:2147-2172). #3153's post-claim census ranked this
// the #2 remaining divergence class on the equivalence corpus (class 1,
// substring/charCodeAt, landed as #3156).
//
// Fix: both-string relational lowers to a call to the mode-resolved compare
// helper (native `__str_compare` / host `string_compare`, both a -1/0/1
// lexicographic sign — §7.2.13 IsLessThan, code-unit order), then folds the
// sign to the operator's boolean via a signed i32 compare against 0. No new
// IR node kind (the #3156 emit-a-named-call pattern). The mixed string/
// non-string case still demotes (unchanged), as does everything else.
//
// Governing spec: ECMA-262 §7.2.13 IsLessThan — two String operands compare
// by UTF-16 code unit (NOT locale, NOT numeric), total for two strings.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "issue-3167.ts", target: "standalone" });
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
  const r = await compile(src, { fileName: "issue-3167.ts" });
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

describe("#3167 — IR string relational operators", () => {
  bothLanes(
    "a < b lexicographic true",
    `export function test(): number { const a="apple"; const b="banana"; return a < b ? 1 : 0; }`,
    1,
  );
  bothLanes(
    "a < b false when a > b",
    `export function test(): number { const a="banana"; const b="apple"; return a < b ? 1 : 0; }`,
    0,
  );
  bothLanes(
    "a > b true",
    `export function test(): number { const a="banana"; const b="apple"; return a > b ? 1 : 0; }`,
    1,
  );
  bothLanes(
    "a <= b true on equal",
    `export function test(): number { const a="apple"; const b="apple"; return a <= b ? 1 : 0; }`,
    1,
  );
  bothLanes(
    "a >= b true on equal",
    `export function test(): number { const a="apple"; const b="apple"; return a >= b ? 1 : 0; }`,
    1,
  );
  bothLanes(
    "a < b false on equal (strict)",
    `export function test(): number { const a="apple"; const b="apple"; return a < b ? 1 : 0; }`,
    0,
  );
  bothLanes(
    "empty string is least",
    `export function test(): number { const a=""; const b="a"; return a < b ? 1 : 0; }`,
    1,
  );
  bothLanes(
    "prefix is less than extension",
    `export function test(): number { const a="app"; const b="apple"; return a < b ? 1 : 0; }`,
    1,
  );
  bothLanes(
    "compares across a function boundary (string params)",
    `function cmp(a: string, b: string): number { return a < b ? 1 : 0; }
     export function test(): number { return cmp("a", "b"); }`,
    1,
  );
  bothLanes(
    "operand from concat (rope) compares by flattened content",
    `export function test(): number { let a="ap"; a = a + "ple"; return a < "banana" ? 1 : 0; }`,
    1,
  );
  bothLanes(
    'code-unit order, not numeric ("10" < "9")',
    `export function test(): number { const a="10"; const b="9"; return a < b ? 1 : 0; }`,
    1,
  );
  bothLanes(
    "sort-style loop over string comparisons",
    `export function test(): number {
       const xs: string[] = ["pear", "apple", "orange"];
       let swaps = 0;
       for (let i = 0; i < xs.length; i++) {
         for (let j = 0; j < xs.length - 1; j++) {
           if (xs[j] > xs[j + 1]) { const t = xs[j]; xs[j] = xs[j + 1]; xs[j + 1] = t; swaps++; }
         }
       }
       return (xs[0] === "apple" && xs[1] === "orange" && xs[2] === "pear") ? swaps : -1;
     }`,
    2,
  );
});
