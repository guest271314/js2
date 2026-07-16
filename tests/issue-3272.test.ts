// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3272 (epic #3182) — src/codegen/index.ts god-file split smoke test.
//
// index.ts was cut from ~14k LOC to ~7k by extracting seven cohesive
// subsystems VERBATIM into new sibling modules — all byte-identity IDENTICAL
// (prove-emit-identity, 39/39 gc/standalone/wasi emits):
//   - wasi.ts                     (WASI/node:fs IO helpers)
//   - linear-type-reservations.ts (linear/typed-array type reservations)
//   - closure-exports.ts          (__call_fn_<N> host dispatch + classification)
//   - struct-field-exports.ts     (__get_field_* / __set_field_* host getters)
//   - vec-access-exports.ts       (__vec_* / __dv_byte_* / __new_vec_f64)
//   - extern-declarations.ts      (declare/extern/enum collection pre-pass)
//   - ast-modifiers.ts            (ts.getModifiers predicates)
// plus DRY dedups (emit-helpers.ts: isSyntheticStructName / exportFunc).
//
// This test is a permanent guard that the re-wired imports/re-exports still
// produce working modules across the gc, standalone and wasi targets — the
// exact index-shift surface the split touches.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function compileAndRun(src: string, target?: "standalone"): Promise<number> {
  const r = await compile(src, target ? { fileName: "test.ts", target } : { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`Compilation failed: ${r.errors[0]?.message ?? "unknown error"}`);
  }
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports.test as () => number)();
}

/** Compile-only guard: assert a program produces a valid module for `target`. */
async function compileOK(src: string, target: "wasi" | "standalone"): Promise<void> {
  const r = await compile(src, { fileName: "test.ts", target });
  if (!r.success) {
    throw new Error(`Compilation failed (${target}): ${r.errors[0]?.message ?? "unknown error"}`);
  }
  // Validate the emitted bytes are a well-formed module.
  expect(WebAssembly.validate(r.binary)).toBe(true);
}

describe("#3272 — index.ts god-file split (extracted subsystems still compile+run)", () => {
  it("struct-field-exports: object field read/write round-trips", async () => {
    expect(
      await compileAndRun(
        `export function test(): number {
           const o = { x: 3, y: 4 };
           o.y = o.x + o.y;
           return o.x + o.y;
         }`,
      ),
    ).toBe(10);
  });

  it("closure-exports: higher-order closure dispatch (__call_fn path)", async () => {
    expect(
      await compileAndRun(
        `export function test(): number {
           const nums = [1, 2, 3, 4];
           return nums.map((n) => n * 2).reduce((a, b) => a + b, 0);
         }`,
      ),
    ).toBe(20);
  });

  it("vec-access-exports: array length + indexed access", async () => {
    expect(
      await compileAndRun(
        `export function test(): number {
           const a: number[] = [5, 6, 7];
           a.push(8);
           let sum = 0;
           for (let i = 0; i < a.length; i++) sum += a[i];
           return sum;
         }`,
      ),
    ).toBe(26);
  });

  it("extern-declarations + ast-modifiers: declared enum + exported fn", async () => {
    expect(
      await compileAndRun(
        `enum Color { Red = 1, Green = 2, Blue = 4 }
         export function test(): number { return Color.Red + Color.Green + Color.Blue; }`,
      ),
    ).toBe(7);
  });

  it("standalone target: struct + closure + vec paths compile and run without a JS host", async () => {
    expect(
      await compileAndRun(
        `export function test(): number {
           const o = { n: 21 };
           const dbl = (v: number) => v * 2;
           const arr = [o.n];
           return dbl(arr[0]);
         }`,
        "standalone",
      ),
    ).toBe(42);
  });

  it("wasi target: linear-type-reservations + wasi IO helper paths emit a valid module", async () => {
    await compileOK(
      `export function main(): void {
         const buf = new Uint8Array(4);
         buf[0] = 65;
         console.log("hi");
       }`,
      "wasi",
    );
  });

  it("standalone target: extern/global usage path emits a valid module", async () => {
    await compileOK(
      `export function test(): number {
         const s = "abc".toUpperCase();
         return s.length;
       }`,
      "standalone",
    );
  });
});
