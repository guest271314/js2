import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #3170 — standalone `fromIndex` for the any-array search methods
// (indexOf / lastIndexOf / includes). The #2583 `$__vec_base` brand arm in
// closed-method-dispatch.ts linear-scanned the WHOLE array and IGNORED the 2nd
// argument, so `a.indexOf(x, n)` / `a.lastIndexOf(x, n)` / `a.includes(x, n)`
// over an any-typed array returned the no-fromIndex answer (wrong per
// §23.1.3.14 / §23.1.3.20 / §23.1.3.15). The fix computes the scan START from
// `ToIntegerOrInfinity(fromIndex)` (`__unbox_number` → NaN→0, else trunc toward
// zero) and the spec clamp:
//   forward (indexOf/includes): k = n≥0 ? n : max(len+n, 0)
//   backward (lastIndexOf):     k = n≥0 ? min(n, len-1) : len+n
//
// NOTE (measurement integrity): the test262 corpus's fromIndex tests
// (`Array/prototype/{indexOf,lastIndexOf,includes}/using-fromindex.js`, the
// `-5-*` series, …) are currently VACUOUS standalone passes — they already
// count as `pass` despite the pre-fix wrong answers — so this correctness fix
// shows ZERO net test262 delta. These direct compile+run assertions are the
// NON-vacuous proof of the fix (they fail on pristine main, pass on the branch).

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): unknown }).test();
}

describe("#3170 standalone any-array search fromIndex (indexOf/lastIndexOf/includes)", () => {
  // ── indexOf forward fromIndex ──
  it("indexOf(x, n) skips indices before n", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[10,20,30,20]; return a.indexOf(20,2); }`),
    ).toBe(3);
  });

  it("indexOf(x, 0) is the whole-array scan", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[10,20,30,20]; return a.indexOf(20,0); }`),
    ).toBe(1);
  });

  it("indexOf(x, -1) starts at len-1", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[10,20,30,20]; return a.indexOf(20,-1); }`),
    ).toBe(3);
  });

  it("indexOf(x, -len) clamps to 0", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[10,20,30,20]; return a.indexOf(20,-4); }`),
    ).toBe(1);
  });

  it("indexOf(x, n) with n>=len returns -1", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[10,20,30]; return a.indexOf(20,5); }`),
    ).toBe(-1);
  });

  it("indexOf(x, n) skips a present earlier match → -1", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[10,20,30]; return a.indexOf(10,1); }`),
    ).toBe(-1);
  });

  it("indexOf(x, n) truncates a fractional fromIndex toward zero", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[10,20,30,20]; return a.indexOf(20,2.9); }`),
    ).toBe(3);
  });

  it("indexOf(x, Infinity) returns -1", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[10,20,30]; return a.indexOf(20,Infinity); }`),
    ).toBe(-1);
  });

  it("indexOf(x, -Infinity) scans from 0", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[10,20,30]; return a.indexOf(20,-Infinity); }`),
    ).toBe(1);
  });

  // ── lastIndexOf backward fromIndex ──
  it("lastIndexOf(x, n) scans backward from n", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[10,20,30,20]; return a.lastIndexOf(20,1); }`),
    ).toBe(1);
  });

  it("lastIndexOf(x, n) with n between matches finds the earlier", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[10,20,30,20]; return a.lastIndexOf(20,2); }`),
    ).toBe(1);
  });

  it("lastIndexOf(x, -1) starts at len-1", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[10,20,30,20]; return a.lastIndexOf(20,-1); }`),
    ).toBe(3);
  });

  it("lastIndexOf(x, -2) starts at len-2", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[10,20,30,20]; return a.lastIndexOf(30,-2); }`),
    ).toBe(2);
  });

  it("lastIndexOf(x, -len) with the match not before it → -1", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[10,20,30,20]; return a.lastIndexOf(20,-4); }`),
    ).toBe(-1);
  });

  it("lastIndexOf(x, -Infinity) returns -1", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const a:any=[10,20,30]; return a.lastIndexOf(20,-Infinity); }`,
      ),
    ).toBe(-1);
  });

  // ── includes fromIndex (SameValueZero) ──
  it("includes(x, n) skipping the only match → false", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[10,20,30]; return a.includes(10,1)?1:0; }`),
    ).toBe(0);
  });

  it("includes(x, n) with the match at/after n → true", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[10,20,30]; return a.includes(20,1)?1:0; }`),
    ).toBe(1);
  });

  it("includes(x, -len) scans the whole array → true", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[10,20,30]; return a.includes(10,-3)?1:0; }`),
    ).toBe(1);
  });

  // ── arity-1 (no fromIndex): behaviour unchanged ──
  it("indexOf without fromIndex is unchanged", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[10,20,30]; return a.indexOf(30); }`),
    ).toBe(2);
  });

  it("lastIndexOf without fromIndex is unchanged", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[10,20,20]; return a.lastIndexOf(20); }`),
    ).toBe(2);
  });

  it("includes without fromIndex is unchanged", async () => {
    expect(
      await runStandalone(`export function test(): number { const a:any=[10,20,30]; return a.includes(30)?1:0; }`),
    ).toBe(1);
  });
});
