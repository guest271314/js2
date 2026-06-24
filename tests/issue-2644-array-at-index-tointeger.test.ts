import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #2644 — Standalone Array.prototype.at index argument ToIntegerOrInfinity
//   (§23.1.3.1 step 2 = §7.1.5: truncate-toward-zero of ToNumber(index)), the
//   Array analog of the String-method fix #2600. The index was coerced directly
//   to i32 instead of via ToNumber→truncate, so a non-integer-typed index on a
//   typed array receiver resolved to the wrong slot: `[10,11,12,13].at("1")`
//   returned 10 (index 0) instead of 11 (index 1) in --target standalone.
//
//   Fix (src/codegen/array-methods.ts, compileArrayAt): under noJsHost route the
//   arg through the existing numeric coercion engine (coerceType(...,{kind:"f64"},
//   "number") — string → __str_to_number, object → ToPrimitive("number")), then
//   ToIntegerOrInfinity (NaN→0, else i32.trunc_sat_f64_s). No new #2108 coercion
//   site. The JS-host path (which coerces via host imports) is unchanged.
//
//   `skipSemanticDiagnostics` mirrors the test262 runner — passing a non-number
//   to a `(index: number)` method is not a hard TS error there.

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

describe("#2644 standalone Array.prototype.at index ToIntegerOrInfinity", () => {
  // The headline bug: a numeric *string* index must ToInteger-coerce.
  it("at('1') → index 1 (was index 0 in standalone)", async () => {
    expect(await runStandalone(`export function test(): number { const a=[10,11,12,13]; return a.at("1"); }`)).toBe(11);
  });

  it("at('2') → index 2", async () => {
    expect(await runStandalone(`export function test(): number { const a=[10,11,12,13]; return a.at("2"); }`)).toBe(12);
  });

  it("at('1.9') → trunc toward zero → index 1", async () => {
    expect(await runStandalone(`export function test(): number { const a=[10,11,12,13]; return a.at("1.9"); }`)).toBe(
      11,
    );
  });

  it("at('') → 0 (empty string ToNumber = 0)", async () => {
    expect(await runStandalone(`export function test(): number { const a=[10,11,12,13]; return a.at(""); }`)).toBe(10);
  });

  it("at('abc') → NaN → ToIntegerOrInfinity 0", async () => {
    expect(await runStandalone(`export function test(): number { const a=[10,11,12,13]; return a.at("abc"); }`)).toBe(
      10,
    );
  });

  it("at('-1') → negative index wraps from end → last element", async () => {
    expect(await runStandalone(`export function test(): number { const a=[10,11,12,13]; return a.at("-1"); }`)).toBe(
      13,
    );
  });

  it("at('-2.5') → trunc to -2 → second from end", async () => {
    expect(await runStandalone(`export function test(): number { const a=[10,11,12,13]; return a.at("-2.5"); }`)).toBe(
      12,
    );
  });

  // Boolean / null already worked but must keep working through the new path.
  it("at(true) → 1", async () => {
    expect(await runStandalone(`export function test(): number { const a=[10,11,12,13]; return a.at(true); }`)).toBe(
      11,
    );
  });

  it("at(false) → 0", async () => {
    expect(await runStandalone(`export function test(): number { const a=[10,11,12,13]; return a.at(false); }`)).toBe(
      10,
    );
  });

  // Plain integer / float numeric indices — regression guards.
  it("at(2) → index 2 (numeric literal unchanged)", async () => {
    expect(await runStandalone(`export function test(): number { const a=[10,11,12,13]; return a.at(2); }`)).toBe(12);
  });

  it("at(-1) → last element (numeric negative unchanged)", async () => {
    expect(await runStandalone(`export function test(): number { const a=[10,11,12,13]; return a.at(-1); }`)).toBe(13);
  });

  it("at(1.9) → trunc to 1 (numeric fractional)", async () => {
    expect(await runStandalone(`export function test(): number { const a=[10,11,12,13]; return a.at(1.9); }`)).toBe(11);
  });

  // gc/host mode must remain correct (the JS-host path is untouched).
  it("gc-mode at('1') → 1 (host path regression guard)", async () => {
    expect(await runGc(`export function test(): number { const a=[10,11,12,13]; return a.at("1"); }`)).toBe(11);
  });

  it("gc-mode at(2) → 2 (host path regression guard)", async () => {
    expect(await runGc(`export function test(): number { const a=[10,11,12,13]; return a.at(2); }`)).toBe(12);
  });
});
