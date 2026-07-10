// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2173 slice-2a — `yield*` over a NUMERIC array / vec in standalone native
 * generators (SF-3 slice-2 of #2157, building on #2170 slice-1 and #2864 R1).
 *
 * `function* g(){ yield* [1,2,3]; yield 4; }` previously bailed to the #680
 * scoped diagnostic standalone (`buildNativeGeneratorPlan` returned null for a
 * `yield*` whose subject was not a native-generator call). Slice-2a delegates to
 * a numeric array / vec by driving a **vec cursor** directly — the array for-of
 * fast path — reading `vec.data[cursor]` (already f64, NO box) and re-yielding
 * it, `cursor++`, until `cursor >= vec.length`, then transferring to the
 * successor state. The vec ref + i32 cursor persist across host re-entries in a
 * two-field delegation slot appended to the outer generator's state struct.
 *
 * The #1320 `__iterator`/`__iterator_next` bridge is deliberately NOT used — it
 * boxes iterator values as externref (`__box_number`/`__unbox_number`, both host
 * imports), which would break the zero-host-import invariant. Every case below
 * asserts ZERO host imports, proving the delegation is pure-WasmGC.
 *
 * Deferred to slice-2b (the #1320 bridge, carries the #2106 dependency):
 * generic `{next()}` iterables, `arr.values()` iterators, and `.return()`/
 * `.throw()` close-forwarding into the iterator.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2173 slice-2a — yield* over a numeric array/vec (standalone)", () => {
  it("yield* [1,2,3]; yield 4 → for-of sums to 10 (the B1 probe)", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number> { yield* [1,2,3]; yield 4; }
export function test(): number { let s=0; for (const x of g()) s+=x; return s; }`),
    ).toBe(10);
  });

  it("delegation-only (no own yield) sums to 6", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number> { yield* [1,2,3]; }
export function test(): number { let s=0; for (const x of g()) s+=x; return s; }`),
    ).toBe(6);
  });

  it("manual next()-sequence yields the array elements then the own yield", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number> { yield* [1,2,3]; yield 4; }
export function test(): number {
  const it = g();
  let r = 0;
  r = r*10 + (it.next().value as number);
  r = r*10 + (it.next().value as number);
  r = r*10 + (it.next().value as number);
  r = r*10 + (it.next().value as number);
  return r;
}`),
    ).toBe(1234);
  });

  it("vec via a variable (const a = [1,2,3]; yield* a)", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number> { const a = [1,2,3]; yield* a; }
export function test(): number { let s=0; for (const x of g()) s+=x; return s; }`),
    ).toBe(6);
  });

  it("vec via a typed parameter (function* g(a: number[]))", async () => {
    expect(
      await runStandalone(`function* g(a: number[]): Generator<number> { yield* a; yield 100; }
export function test(): number { let s=0; for (const x of g([1,2,3])) s+=x; return s; }`),
    ).toBe(106);
  });

  it("two sequential yield* sites sum to 21", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number> { yield* [1,2,3]; yield* [4,5,6]; }
export function test(): number { let s=0; for (const x of g()) s+=x; return s; }`),
    ).toBe(21);
  });

  it("yield* inside a loop re-iterates the vec each pass", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number> { for (let i=0;i<2;i++) { yield* [1,2,3]; } }
export function test(): number { let s=0; for (const x of g()) s+=x; return s; }`),
    ).toBe(12);
  });

  it("own yield before yield* (order preserved)", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number> { yield 5; yield* [4,6]; }
export function test(): number { let s=0; for (const x of g()) s+=x; return s; }`),
    ).toBe(15);
  });

  it("const x = yield* [1,2] binding — successor state runs to completion", async () => {
    // §27.5.3.7: the yield* expression's value is the iterator's completion
    // value (`undefined` for an array). We assert the SUCCESSOR runs (delivers
    // 99); we deliberately do NOT assert `x`'s value (the f64 undefined-as-NaN
    // sentinel is the #2106 value-rep residual, same as no-arg .next() bindings).
    expect(
      await runStandalone(`function* g(): Generator<number> { const x = yield* [1,2]; yield 99; }
export function test(): number { const it=g(); it.next(); it.next(); return it.next().value as number; }`),
    ).toBe(99);
  });

  it("zero-length typed vec — straight to the successor, no suspension from the vec", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number> { const a: number[] = []; yield* a; yield 7; }
export function test(): number { let s=0; for (const x of g()) s+=x; return s; }`),
    ).toBe(7);
  });

  it("element count across the delegation boundary is 4", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number> { yield* [10,20,30]; yield 40; }
export function test(): number { let n=0; for (const _ of g()) n++; return n; }`),
    ).toBe(4);
  });

  it("regression — a plain numeric generator (no yield*) still sums correctly", async () => {
    expect(
      await runStandalone(`function* g(): Generator<number> { yield 1; yield 2; yield 3; }
export function test(): number { let s=0; for (const x of g()) s+=x; return s; }`),
    ).toBe(6);
  });
});
