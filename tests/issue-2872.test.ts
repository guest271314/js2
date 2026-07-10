// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2872 — standalone GENERAL dynamic TypedArray construction + dyn-view `.fill`.
//
// The test262 TypedArray harness drives every prototype test through
// `testWithTypedArrayConstructors(function (TA) { new TA(…) … })` — the ctor is
// an `any`-typed callback param. #3054 D covered only the `(buffer[,off[,len]])`
// form; the dominant forms — `new TA(n)`, `new TA([…])`, `new TA(arrayLike)`,
// `new TA(otherTA)`, `new TA()` — fell through to `ref.null.extern`, so every
// downstream read yielded 0/undefined (~294 host-pass/standalone-fail). This
// suite pins the runtime `$__ta_ctor`-gated construct arm, the `$__ta_dyn_view`
// `.fill` (§23.2.3.8) two-arm, and the `CanvasRenderingContext2D_fill`
// extern-class hijack refusal (host-free instantiation).

async function run(src: string, target?: "standalone"): Promise<number> {
  const r = await compile(src, target ? { target } : {});
  expect(r.success, r.errors?.map((e) => e.message).join("\n")).toBe(true);
  if (target === "standalone") {
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(r.binary));
    expect(imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  }
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const exp = instance.exports as { test?: () => number; setExports?: (e: unknown) => void };
  return exp.test!();
}

const HARNESS = `function testWith(fn: any) { fn(Int8Array); }\n`;

describe("#2872 standalone dynamic TypedArray construction", () => {
  it("count form: new TA(n) allocates n zeroed elements", async () => {
    expect(
      await run(
        HARNESS +
          `let out = -1;
           testWith(function(TA: any) { const a = new TA(3); out = a.length * 10 + a[1]; });
           export function test(): number { return out; }`,
        "standalone",
      ),
    ).toBe(30);
  });

  it("array form: new TA([…]) copies elements", async () => {
    expect(
      await run(
        HARNESS +
          `let out = -1;
           testWith(function(TA: any) { const a = new TA([1, 2, 3]); out = a.length * 1000 + a[0] * 100 + a[1] * 10 + a[2]; });
           export function test(): number { return out; }`,
        "standalone",
      ),
    ).toBe(3123);
  });

  it("array-like $Object form: new TA({length, 0: …}) copies via the length walk", async () => {
    expect(
      await run(
        HARNESS +
          `let out = -1;
           testWith(function(TA: any) { const al: any = { length: 3, 0: 5, 1: 6, 2: 7 };
             const a = new TA(al); out = a.length * 1000 + a[0] * 100 + a[1] * 10 + a[2]; });
           export function test(): number { return out; }`,
        "standalone",
      ),
    ).toBe(3567);
  });

  it("zero-arg form: new TA() is a 0-length view", async () => {
    expect(
      await run(
        HARNESS +
          `let out = -1;
           testWith(function(TA: any) { const a = new TA(); out = a.length; });
           export function test(): number { return out; }`,
        "standalone",
      ),
    ).toBe(0);
  });

  it("view-copy form: new TA(otherDynView) re-encodes element-by-element", async () => {
    expect(
      await run(
        HARNESS +
          `let out = -1;
           testWith(function(TA: any) {
             const src = new TA([4, 5, 6]);
             const dst = new TA(src);
             src[0] = 9; // copies don't alias
             out = dst.length * 1000 + dst[0] * 100 + dst[1] * 10 + dst[2];
           });
           export function test(): number { return out; }`,
        "standalone",
      ),
    ).toBe(3456);
  });

  it("element write/read round-trips with per-kind encoding (Int8 wrap)", async () => {
    expect(
      await run(
        HARNESS +
          `let out = -1;
           testWith(function(TA: any) { const a = new TA(2); a[0] = 130; out = a[0]; });
           export function test(): number { return out; }`,
        "standalone",
      ),
    ).toBe(-126);
  });

  it('string/undefined count args follow ToIndex ("3" → 3, undefined → 0)', async () => {
    expect(
      await run(
        HARNESS +
          `let out = -1;
           testWith(function(TA: any) { const s: any = "3"; const a = new TA(s); const b = new TA(undefined);
             out = a.length * 10 + b.length; });
           export function test(): number { return out; }`,
        "standalone",
      ),
    ).toBe(30);
  });

  it("non-TA dynamic callee still constructs through the class dispatch (no hijack)", async () => {
    expect(
      await run(
        `class K { v: number; constructor(v: number) { this.v = v; } }
         function mk(C: any): any { return new C(7); }
         export function test(): number { const o: any = mk(K); return o.v; }`,
        "standalone",
      ),
    ).toBe(7);
  });
});

describe("#2872 dyn-view .fill", () => {
  it("fill(v, start) mutates the shared buffer on the runtime kind", async () => {
    expect(
      await run(
        HARNESS +
          `let out = -1;
           testWith(function(TA: any) { const a = new TA([0, 0, 0]).fill(8, 1);
             out = a.length * 1000 + a[0] * 100 + a[1] * 10 + a[2]; });
           export function test(): number { return out; }`,
        "standalone",
      ),
    ).toBe(3088);
  });

  it("fill relative indices clamp per §23.2.3.8 (negative start, start > len)", async () => {
    expect(
      await run(
        HARNESS +
          `let out = -1;
           testWith(function(TA: any) {
             const a = new TA([0, 0, 0]).fill(8, -1); // start = max(len-1, 0)
             const b = new TA([0, 0, 0]).fill(8, 4);  // start clamps to len → no-op
             out = a[2] * 10 + (b[0] + b[1] + b[2]);
           });
           export function test(): number { return out; }`,
        "standalone",
      ),
    ).toBe(80);
  });

  it("fill returns this (identity observed through content aliasing)", async () => {
    expect(
      await run(
        HARNESS +
          `let out = -1;
           testWith(function(TA: any) {
             const a = new TA(3);
             const b = a.fill(1);
             b[0] = 9;            // writes through the SAME buffer
             out = a[0] * 10 + a[1];
           });
           export function test(): number { return out; }`,
        "standalone",
      ),
    ).toBe(91);
  });

  it("fill end arg (explicit window)", async () => {
    expect(
      await run(
        HARNESS +
          `let out = -1;
           testWith(function(TA: any) { const a = new TA([0, 0, 0, 0]).fill(7, 1, 3);
             out = a[0] * 1000 + a[1] * 100 + a[2] * 10 + a[3]; });
           export function test(): number { return out; }`,
        "standalone",
      ),
    ).toBe(770);
  });

  it("fill on a plain any-array receiver keeps the dispatcher path (no dyn-view hijack)", async () => {
    // A plain array through `any` falls to the ordinary dispatcher; the
    // ref.test $__ta_dyn_view arm must not capture it. (fill on plain any
    // arrays is a separate gap — this only pins "no wrong capture / no trap".)
    expect(
      await run(
        HARNESS +
          `let out = -1;
           testWith(function(TA: any) { const p: any = [1, 2]; p.fill; out = p.length; });
           export function test(): number { return out; }`,
        "standalone",
      ),
    ).toBe(2);
  });

  it("static-lane control: .fill on a statically-typed Int8Array is unaffected", async () => {
    expect(
      await run(
        `export function test(): number { const a = new Int8Array([0, 0, 0]); a.fill(8, 1); return a[0] * 100 + a[1] * 10 + a[2]; }`,
        "standalone",
      ),
    ).toBe(88);
  });
});
