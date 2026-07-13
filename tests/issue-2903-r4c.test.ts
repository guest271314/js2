// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2903 R4c — standalone `Uint8ClampedArray.map`/`filter` (typed-RESULT callback
// HOFs with round-half-to-even CLAMP store).
//
// R4b (#2989) landed native `__ta_map_<kind>`/`__ta_filter_<kind>` for the six
// packed-INTEGER views (Int8/Uint8/Int16/Uint16/Int32/Uint32), storing the
// callback result with `i32.trunc_sat_f64_s` (JS ToInt8/ToUint8 width-wrapping).
// `Uint8ClampedArray` shares the `i8_byte` carrier but its element conversion is
// §7.1.11 ToUint8Clamp — NaN→0, ≤0→0, ≥255→255, else round-HALF-TO-EVEN — NOT
// modulo truncation. R4c routes it to a DISTINCT clamp helper
// (`__ta_map_clamp_<idx>`) so the shared-carrier collision is avoided.
//
// On main these leaked `env.__make_callback` (host-free instantiation failed)
// and returned nothing — same symptom R4b fixed for the truncating views.
// Standalone-gated → gc/wasi keep the existing host path (byte-identical).
//
// DEFERRED (documented follow-up, out of this bounded slice): the `any`-held
// receiver (kind erased to externref across a fn boundary). It needs a runtime
// carrier-kind dispatch, and crucially the clamp-vs-truncate distinction is
// UNRECOVERABLE from the carrier alone — a `Uint8ClampedArray` and a `Uint8Array`
// share the identical `i8_byte` struct, so a runtime kind TAG is required. That
// is a substrate-level concern tracked separately.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string): Promise<number> {
  const result = await compile(source, {
    fileName: "test.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  expect((result.imports ?? []).map((i) => i.name)).toEqual([]); // host-free
  const { instance } = await WebAssembly.instantiate(result.binary!, {}); // zero imports
  return (instance.exports as { test(): number }).test();
}

describe("#2903 R4c — standalone Uint8ClampedArray map/filter are native + host-free", () => {
  it("map applies the callback (in-range values pass through)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8ClampedArray([1, 2, 3]); const b = a.map((x: number) => x * 2); return b[0] + b[1] + b[2]; }`,
      ),
    ).toBe(12);
  });

  it("map clamps overflow to 255 (300 → 255), NOT modulo (would be 44)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8ClampedArray([100, 200, 50]); const b = a.map((x: number) => x + 100); return b[1]; }`,
      ),
    ).toBe(255);
  });

  it("map clamps negatives to 0", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8ClampedArray([10]); const b = a.map((x: number) => x - 100); return b[0]; }`,
      ),
    ).toBe(0);
  });

  it("map rounds half-to-even: 2.5 → 2", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8ClampedArray([1]); const b = a.map((x: number) => 2.5); return b[0]; }`,
      ),
    ).toBe(2);
  });

  it("map rounds half-to-even: 3.5 → 4", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8ClampedArray([1]); const b = a.map((x: number) => 3.5); return b[0]; }`,
      ),
    ).toBe(4);
  });

  it("map rounds half-to-even: 0.5 → 0 and 1.5 → 2 (sum 2)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8ClampedArray([1, 1]); const b = a.map((x: number, i: number) => i === 0 ? 0.5 : 1.5); return b[0] + b[1]; }`,
      ),
    ).toBe(2);
  });

  it("map rounds non-ties normally: 2.4 → 2, 2.6 → 3 (sum 5)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8ClampedArray([1, 1]); const b = a.map((x: number, i: number) => i === 0 ? 2.4 : 2.6); return b[0] + b[1]; }`,
      ),
    ).toBe(5);
  });

  it("map passes the index as the second callback arg", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8ClampedArray([10, 20, 30]); const b = a.map((x: number, i: number) => x + i); return b[0] + b[1] + b[2]; }`,
      ),
    ).toBe(63);
  });

  it("filter keeps matching elements (length + values)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8ClampedArray([5, 2, 8, 1, 9]); const b = a.filter((x: number) => x >= 5); return b.length * 1000 + b[0] * 100 + b[1] * 10 + b[2]; }`,
      ),
    ).toBe(3589);
  });

  it("filter empty result has length 0", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8ClampedArray([1, 2, 3]); const b = a.filter((x: number) => x > 100); return b.length; }`,
      ),
    ).toBe(0);
  });

  it("filter preserves the (already-clamped) element values, reads unsigned", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a = new Uint8ClampedArray([200, 10, 250]); const b = a.filter((x: number) => x >= 100); return b.length * 1000 + b[0] + b[1]; }`,
      ),
    ).toBe(2450);
  });
});
