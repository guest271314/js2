// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

// #2872 slice 2 — standalone dyn-view `copyWithin` (§23.2.3.5) + `reverse`
// (§23.2.3.21) over a runtime `$__ta_dyn_view` receiver (the
// `testWithTypedArrayConstructors(TA => new TA(…).copyWithin(…)/.reverse())`
// harness shape). Before this, an `any`-receiver copyWithin/reverse either
// no-op'd through the open-object dispatcher (copyWithin) or leaked a host
// `Uint8ClampedArray_reverse` import (reverse), so the whole cluster failed
// standalone. Both mint native helpers (host-free), operate on the shared
// buffer, and return `this` (verified via content-aliasing, since dyn-view
// strict-eq identity is a separate deferred gap — #2580 M2).

async function run(src: string, target?: "standalone"): Promise<number> {
  const r = (await compile(src, target ? { target } : {})) as {
    success: boolean;
    errors?: { message: string }[];
    binary: Uint8Array;
    importObject?: WebAssembly.Imports;
  };
  expect(r.success, r.errors?.map((e) => e.message).join("\n")).toBe(true);
  if (target === "standalone") {
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(r.binary));
    expect(imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  }
  // Standalone binaries are host-free ({}); the default (JS-host) lane needs the
  // compiler-provided import object.
  const { instance } = await WebAssembly.instantiate(r.binary, target === "standalone" ? {} : (r.importObject ?? {}));
  return (instance.exports as { test?: () => number }).test!();
}

const H = `function testWith(fn: any) { fn(Int8Array); }\n`;
const HU8 = `function testWith(fn: any) { fn(Uint8Array); }\n`;
const HI16 = `function testWith(fn: any) { fn(Int16Array); }\n`;
const HF64 = `function testWith(fn: any) { fn(Float64Array); }\n`;

describe("#2872 dyn-view copyWithin", () => {
  it("copyWithin(target, start) copies within the shared buffer (host-free)", async () => {
    expect(
      await run(
        H +
          `let out = -1;
           testWith(function(TA: any) { const a = new TA([1,2,3,4,5]); a.copyWithin(0,3);
             out = a[0]*10000+a[1]*1000+a[2]*100+a[3]*10+a[4]; });
           export function test(): number { return out; }`,
        "standalone",
      ),
    ).toBe(45345);
  });

  it("copyWithin(target, start, end) honors the explicit end window", async () => {
    expect(
      await run(
        `function testWith(fn: any) { fn(Int32Array); }\n` +
          `let out = -1;
           testWith(function(TA: any) { const a = new TA([1,2,3,4,5]); a.copyWithin(1,3,5);
             out = a[0]*10000+a[1]*1000+a[2]*100+a[3]*10+a[4]; });
           export function test(): number { return out; }`,
        "standalone",
      ),
    ).toBe(14545);
  });

  it("copyWithin negative relative indices clamp to [0, len]", async () => {
    expect(
      await run(
        HU8 +
          `let out = -1;
           testWith(function(TA: any) { const a = new TA([1,2,3,4,5]); a.copyWithin(-2,0);
             out = a[0]*10000+a[1]*1000+a[2]*100+a[3]*10+a[4]; });
           export function test(): number { return out; }`,
        "standalone",
      ),
    ).toBe(12312);
  });

  it("copyWithin on a multi-byte element kind moves whole elements (Float64)", async () => {
    expect(
      await run(
        HF64 +
          `let out = -1;
           testWith(function(TA: any) { const a = new TA([1.5,2.5,3.5]); a.copyWithin(0,1);
             out = (a[0]===2.5 && a[1]===3.5 && a[2]===3.5) ? 1 : 0; });
           export function test(): number { return out; }`,
        "standalone",
      ),
    ).toBe(1);
  });

  it("copyWithin returns this (observed through content aliasing)", async () => {
    expect(
      await run(
        H +
          `let out = -1;
           testWith(function(TA: any) { const a = new TA([1,2,3]); const b = a.copyWithin(0,1);
             b[0] = 99; out = (a[0] === 99) ? 1 : 0; });
           export function test(): number { return out; }`,
        "standalone",
      ),
    ).toBe(1);
  });
});

describe("#2872 dyn-view reverse", () => {
  it("reverse() reverses in place, odd length keeps the middle (host-free)", async () => {
    expect(
      await run(
        HU8 +
          `let out = -1;
           testWith(function(TA: any) { const a = new TA([1,2,3,4,5]); a.reverse();
             out = a[0]*10000+a[1]*1000+a[2]*100+a[3]*10+a[4]; });
           export function test(): number { return out; }`,
        "standalone",
      ),
    ).toBe(54321);
  });

  it("reverse() on a multi-byte element kind swaps whole elements (Int16)", async () => {
    expect(
      await run(
        HI16 +
          `let out = -1;
           testWith(function(TA: any) { const a = new TA([10,20,30,40]); a.reverse();
             out = a[0]*1000+a[1]*100+a[2]*10+a[3]; });
           export function test(): number { return out; }`,
        "standalone",
      ),
    ).toBe(40 * 1000 + 30 * 100 + 20 * 10 + 10);
  });

  it("reverse() returns this (observed through content aliasing)", async () => {
    expect(
      await run(
        H +
          `let out = -1;
           testWith(function(TA: any) { const a = new TA([1,2,3]); const b = a.reverse();
             b[0] = 77; out = (a[0] === 77) ? 1 : 0; });
           export function test(): number { return out; }`,
        "standalone",
      ),
    ).toBe(1);
  });
});

describe("#2872 slice-2 guards", () => {
  it("plain any-array copyWithin is NOT hijacked by the dyn-view arm", async () => {
    expect(
      await run(
        H +
          `let out = -1;
           testWith(function(TA: any) { const p: any = [1,2,3]; p.copyWithin(0,1); out = p.length; });
           export function test(): number { return out; }`,
        "standalone",
      ),
    ).toBe(3);
  });

  it("static-lane control: copyWithin on a statically-typed Int8Array is unaffected", async () => {
    expect(
      await run(
        `export function test(): number { const a = new Int8Array([1,2,3,4,5]); a.copyWithin(0,3);
           return a[0]*10000+a[1]*1000+a[2]*100+a[3]*10+a[4]; }`,
      ),
    ).toBe(45345);
  });

  it("static-lane control: reverse on a statically-typed Uint8Array is unaffected", async () => {
    expect(
      await run(
        `export function test(): number { const a = new Uint8Array([1,2,3,4,5]); a.reverse();
           return a[0]*10000+a[1]*1000+a[2]*100+a[3]*10+a[4]; }`,
      ),
    ).toBe(54321);
  });
});
