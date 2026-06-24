import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #2648 — Standalone TypedArray.prototype.{indexOf,lastIndexOf,includes} on a
//   sub-32-bit (packed i8/i16) typed array was a hard COMPILE ERROR:
//     "packed storage type 'i8' is not valid in a value position"
//   The search-value local was allocated with the raw packed element type
//   (i8/i16), which is only valid as a struct field / array element — never in
//   a param/result/local/global. (Mirrors the #2159 fix for .fill().)
//
//   Fix (src/codegen/array-methods.ts): hold the search value in the UNPACKED
//   i32 (unpackedElemType), and drive the element load off the VIEW-NAME
//   signedness (Int8/Int16 → array.get_s; Uint8/Uint8Clamped/Uint16 →
//   array.get_u; mirrors #2593) so signed negatives and unsigned-high values
//   both match. 32-bit+ views (Int32/Uint32/Float32/Float64) and plain arrays
//   are unchanged.

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone", skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}
async function runGc(src: string): Promise<unknown> {
  const r = await compile(src, { skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject ?? {});
  return (instance.exports as { test(): unknown }).test();
}

const VIEWS = ["Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array"];

describe("#2648 standalone TypedArray search on packed i8/i16 elements", () => {
  // The headline: these were a hard compile error for every packed view.
  for (const V of VIEWS) {
    it(`${V} indexOf positive value compiles + matches`, async () => {
      expect(
        await runStandalone(
          `export function test(): number { const a=new ${V}([10,11,12,13]); return a.indexOf(12); }`,
        ),
      ).toBe(2);
    });
    it(`${V} includes positive value`, async () => {
      expect(
        await runStandalone(
          `export function test(): number { const a=new ${V}([10,11,12,13]); return a.includes(11)?1:0; }`,
        ),
      ).toBe(1);
    });
    it(`${V} lastIndexOf positive value`, async () => {
      expect(
        await runStandalone(
          `export function test(): number { const a=new ${V}([10,11,11,13]); return a.lastIndexOf(11); }`,
        ),
      ).toBe(2);
    });
  }

  // Signedness — signed views must match negatives (array.get_s).
  it("Int8Array indexOf(-1) (signed load)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a=new Int8Array([10,-1,12]); return a.indexOf(-1); }`,
      ),
    ).toBe(1);
  });
  it("Int8Array includes(-1)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a=new Int8Array([10,-1,12]); return a.includes(-1)?1:0; }`,
      ),
    ).toBe(1);
  });
  it("Int8Array lastIndexOf(-1)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a=new Int8Array([10,-1,-1]); return a.lastIndexOf(-1); }`,
      ),
    ).toBe(2);
  });
  it("Int16Array indexOf(-5) (signed load)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a=new Int16Array([10,-5,12]); return a.indexOf(-5); }`,
      ),
    ).toBe(1);
  });

  // Signedness — unsigned views must match high values (array.get_u).
  it("Uint8Array indexOf(200) (unsigned load)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a=new Uint8Array([10,200,12]); return a.indexOf(200); }`,
      ),
    ).toBe(1);
  });
  it("Uint8Array includes(255)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a=new Uint8Array([10,255,12]); return a.includes(255)?1:0; }`,
      ),
    ).toBe(1);
  });
  it("Uint16Array indexOf(40000) (unsigned load)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a=new Uint16Array([10,40000,12]); return a.indexOf(40000); }`,
      ),
    ).toBe(1);
  });

  // Not-found.
  it("Int8Array indexOf miss → -1", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a=new Int8Array([10,11,12]); return a.indexOf(99); }`,
      ),
    ).toBe(-1);
  });
  it("Uint8Array includes miss → 0", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a=new Uint8Array([10,11,12]); return a.includes(99)?1:0; }`,
      ),
    ).toBe(0);
  });

  // Regression guards: 32-bit+ views, NaN SameValueZero, plain arrays unchanged.
  it("Int32Array indexOf unchanged", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a=new Int32Array([10,11,12]); return a.indexOf(12); }`,
      ),
    ).toBe(2);
  });
  it("Float64Array includes(NaN) SameValueZero", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a=new Float64Array([1,NaN,3]); return a.includes(NaN)?1:0; }`,
      ),
    ).toBe(1);
  });
  it("Float64Array indexOf(NaN) → -1 (strict eq)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a=new Float64Array([1,NaN,3]); return a.indexOf(NaN); }`,
      ),
    ).toBe(-1);
  });
  it("plain number[] indexOf unchanged", async () => {
    expect(await runStandalone(`export function test(): number { const a=[10,11,12]; return a.indexOf(12); }`)).toBe(2);
  });

  // gc/host mode regression guards.
  it("gc-mode Int8Array indexOf(-1)", async () => {
    expect(
      await runGc(`export function test(): number { const a=new Int8Array([10,-1,12]); return a.indexOf(-1); }`),
    ).toBe(1);
  });
  it("gc-mode Uint16Array indexOf(40000)", async () => {
    expect(
      await runGc(
        `export function test(): number { const a=new Uint16Array([10,40000,12]); return a.indexOf(40000); }`,
      ),
    ).toBe(1);
  });
});
