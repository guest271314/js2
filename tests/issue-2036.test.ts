import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2036 PR-1 — standalone Array.prototype generics over a real array-like
// `$Object` receiver ({0:x, length:n}).
//
// The target-agnostic array-like loop in `compileArrayLikePrototypeCall`
// reads the receiver via __extern_length / __extern_get_idx / __extern_has_idx.
// In standalone those are NATIVE helpers (object-runtime.ts) that previously
// only recognised the enumeration-result `$ObjVec` and returned 0/null for a
// real array-like `$Object` — so the generic loop ran with len 0 and the
// callback methods produced wrong results / null-derefs.
//
// PR-1 teaches the three helpers an `$Object` arm: __extern_length does
// ToLength(Get(O,"length")), __extern_get_idx returns __extern_get(O,
// ToString(idx)), __extern_has_idx returns HasProperty(O, ToString(idx)) — all
// via the canonical number_toString key stringifier and the existing proto-walk
// in __extern_get/__extern_has. Gated on standalone; gc/host uses the JS import.
//
// Scope note: the SEARCH methods (indexOf/lastIndexOf/includes) and `filter`
// over an `$Object` receiver still emit invalid Wasm in standalone due to a
// SEPARATE pre-existing codegen bug in their call-site loop (the binary emitter
// mis-types a local — same on origin/main, independent of this helper fix). Those
// are not asserted here; they need a follow-up. The callback methods that route
// through the generic loop (forEach/some/every/find/findIndex) are fixed and
// covered below.

async function runStandalone(body: string): Promise<unknown> {
  const r = await compile(body, { fileName: "test.ts", target: "standalone" });
  if (!r.success) {
    throw new Error(`Compile failed:\n${r.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#2036 standalone Array.prototype generics over array-like $Object", () => {
  it("forEach reads length + elements from an array-like $Object", async () => {
    expect(
      await runStandalone(
        `function probe(o: any): number {
           let s = 0;
           Array.prototype.forEach.call(o, (x: any) => { s += x; });
           return s;
         }
         export function test(): number {
           const o: any = { 0: 5, 1: 6, length: 2 };
           return probe(o);
         }`,
      ),
    ).toBe(11);
  });

  it("some returns true when a matching element exists", async () => {
    expect(
      await runStandalone(
        `function probe(o: any): number {
           return Array.prototype.some.call(o, (x: any) => x === 6) ? 1 : 0;
         }
         export function test(): number {
           const o: any = { 0: 5, 1: 6, length: 2 };
           return probe(o);
         }`,
      ),
    ).toBe(1);
  });

  it("every checks all in-range elements", async () => {
    expect(
      await runStandalone(
        `function probe(o: any): number {
           return Array.prototype.every.call(o, (x: any) => x > 0) ? 1 : 0;
         }
         export function test(): number {
           const o: any = { 0: 5, 1: 6, length: 2 };
           return probe(o);
         }`,
      ),
    ).toBe(1);
  });

  it("findIndex returns the index of the first match", async () => {
    expect(
      await runStandalone(
        `function probe(o: any): number {
           return Array.prototype.findIndex.call(o, (x: any) => x === 6);
         }
         export function test(): number {
           const o: any = { 0: 5, 1: 6, length: 2 };
           return probe(o);
         }`,
      ),
    ).toBe(1);
  });

  it("length is read as ToLength (only in-range indices visited)", async () => {
    // length:1 means only index 0 is visited even though index 1 has a value.
    expect(
      await runStandalone(
        `function probe(o: any): number {
           let s = 0;
           Array.prototype.forEach.call(o, (x: any) => { s += x; });
           return s;
         }
         export function test(): number {
           const o: any = { 0: 5, 1: 6, length: 1 };
           return probe(o);
         }`,
      ),
    ).toBe(5);
  });

  it("hole-skipping: forEach does not visit absent indices", async () => {
    // index 1 is absent (a hole) — forEach must skip it (callback count 1).
    expect(
      await runStandalone(
        `function probe(o: any): number {
           let count = 0;
           Array.prototype.forEach.call(o, (_x: any) => { count += 1; });
           return count;
         }
         export function test(): number {
           const o: any = { 0: 5, length: 2 };
           return probe(o);
         }`,
      ),
    ).toBe(1);
  });
});
