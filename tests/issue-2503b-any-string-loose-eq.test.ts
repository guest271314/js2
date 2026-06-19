// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2503b — `any`/object operand `==`/`===` against a statically string-typed
 * RIGHT operand mis-coerced the string to a boxed number.
 *
 * The coercion plan in `binary-ops.ts` routed `"lit" == any` (left string) to
 * `compileStringBinaryOp` (correct string-aware §7.2.15 dispatch), but the
 * reversed `any == "lit"` (right string) fell through to the equality/`noJsHost`
 * dispatch, which ToNumber-coerced the string literal to
 * `__box_number(__str_to_number("lit"))` = NaN. So equal strings compared
 * unequal — `function eq(a:any){return a=="ab";} eq("ab")` returned `false`
 * standalone (while `a==="ab"` and the reversed `"ab"==a` returned `true`).
 *
 * Fix: a symmetric equality arm routes a string-typed RIGHT operand against a
 * non-numeric LEFT (`any`/object/string) through `compileStringBinaryOp`,
 * restoring operand-order independence. Tested in both standalone and JS-host
 * modes.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runBool(src: string, target: "standalone" | "gc"): Promise<number> {
  const r = await compile(src, { fileName: "issue-2503b.ts", target });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const imports = target === "standalone" ? {} : { env: { __box_number: (x: number) => x } };
  const { instance } = await WebAssembly.instantiate(r.binary, imports as never);
  return (instance.exports as { test(): number }).test();
}

const cases: Array<[string, string, number]> = [
  [
    "any == lit (equal)",
    `function eq(a: any): boolean { return a == "ab"; } export function test(): boolean { return eq("ab"); }`,
    1,
  ],
  [
    "any == lit (mismatch)",
    `function eq(a: any): boolean { return a == "ab"; } export function test(): boolean { return eq("xy") ? false : true; }`,
    1,
  ],
  [
    "any != lit (equal → false)",
    `function eq(a: any): boolean { return a != "ab"; } export function test(): boolean { return eq("ab") ? false : true; }`,
    1,
  ],
  [
    "any === lit (equal)",
    `function eq(a: any): boolean { return a === "ab"; } export function test(): boolean { return eq("ab"); }`,
    1,
  ],
  [
    "lit == any (reversed, equal)",
    `function eq(a: any): boolean { return "ab" == a; } export function test(): boolean { return eq("ab"); }`,
    1,
  ],
];

describe("#2503b any-vs-typed-string `==` no NaN mis-coercion (standalone)", () => {
  for (const [name, src, expected] of cases) {
    it(name, async () => {
      expect(await runBool(src, "standalone")).toBe(expected);
    });
  }
});

// JS-host mode routes these comparisons through `__host_loose_eq`/`__host_eq`
// (correct JS `==`/`===`), so the standalone-only NaN mis-coercion never applied
// there. We only assert the rerouting does not break codegen/validation in
// JS-host mode (full host-string instantiation needs the wasm:js-string glue,
// out of scope for this unit test).
describe("#2503b any-vs-typed-string `==` (JS-host mode — compiles & validates)", () => {
  for (const [name, src] of cases) {
    it(name, async () => {
      const r = await compile(src, { fileName: "issue-2503b-host.ts", target: "gc" });
      expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
      await expect(WebAssembly.compile(r.binary)).resolves.toBeDefined();
    });
  }
});
