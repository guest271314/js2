// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2059 — relational operators on two `any` operands skipped §7.2.13 string
// comparison. With `any`/externref operands the compiler unboxed both to f64
// (`Number("a")` → NaN), so every string relational yielded `false`.
//
// The fix (`emitAnyRelational`, src/codegen/binary-ops.ts) routes any/unknown
// relationals through a 4-way comparator (-1/0/1/2) that does §7.2.13 dispatch:
//   - JS-host mode: `__host_compare(externref, externref)` delegates to the
//     native JS relational operators.
//   - Standalone/WASI: an in-module dispatch — both-string operands compare
//     lexicographically via `__str_compare`; otherwise ToNumber both
//     (`__unbox_number`) and compare as f64 (NaN propagates to `false`).
// The provably-numeric fast path is untouched (the gate only fires when one
// operand is statically any/unknown).
//
// Strings are materialised INSIDE the module so the standalone path is
// exercised faithfully (passing JS strings across the boundary into a
// standalone export marshals to a different representation and is not how
// test262 runs these programs).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

type Mode = { label: string; opts: Record<string, unknown> };
const MODES: Mode[] = [
  { label: "host", opts: {} },
  { label: "standalone", opts: { target: "standalone" } },
];

async function runExport(src: string, name: string, opts: Record<string, unknown>): Promise<unknown> {
  const result = await compile(src, { fileName: "test.ts", ...opts });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  const importObject: any = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  return (instance.exports as Record<string, () => unknown>)[name]();
}

describe("#2059 — any < any performs §7.2.13 string comparison", () => {
  for (const { label, opts } of MODES) {
    describe(`[${label}]`, () => {
      it('"a" < "b" is true (lexicographic)', async () => {
        expect(
          await runExport(
            `export function test(): boolean { const a: any = "a"; const b: any = "b"; return a < b; }`,
            "test",
            opts,
          ),
        ).toBe(1);
      });

      it('"10" < "9" is true (lexicographic, not numeric)', async () => {
        expect(
          await runExport(
            `export function test(): boolean { const a: any = "10"; const b: any = "9"; return a < b; }`,
            "test",
            opts,
          ),
        ).toBe(1);
      });

      it('"10" < 9 is false (mixed string/number → numeric)', async () => {
        expect(
          await runExport(
            `export function test(): boolean { const a: any = "10"; const b: any = 9; return a < b; }`,
            "test",
            opts,
          ),
        ).toBe(0);
      });

      it('"b" > "a" is true', async () => {
        expect(
          await runExport(
            `export function test(): boolean { const a: any = "b"; const b: any = "a"; return a > b; }`,
            "test",
            opts,
          ),
        ).toBe(1);
      });

      it('"a" <= "a" is true', async () => {
        expect(
          await runExport(
            `export function test(): boolean { const a: any = "a"; const b: any = "a"; return a <= b; }`,
            "test",
            opts,
          ),
        ).toBe(1);
      });

      it('"b" >= "a" is true', async () => {
        expect(
          await runExport(
            `export function test(): boolean { const a: any = "b"; const b: any = "a"; return a >= b; }`,
            "test",
            opts,
          ),
        ).toBe(1);
      });

      it("NaN < 1 is false (NaN-operand relationals are false)", async () => {
        expect(
          await runExport(
            `export function test(): boolean { const a: any = NaN; const b: any = 1; return a < b; }`,
            "test",
            opts,
          ),
        ).toBe(0);
      });

      it("provably-numeric compare is unchanged (fast path)", async () => {
        expect(
          await runExport(
            `export function test(): boolean { const a: number = 1; const b: number = 2; return a < b; }`,
            "test",
            opts,
          ),
        ).toBe(1);
      });
    });
  }
});
