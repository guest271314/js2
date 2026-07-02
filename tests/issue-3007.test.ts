import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// #3007 — a computed numeric read `recv[idx]` on an `any`/externref receiver
// routes through the (#2784 S3) native-vec-aware fast path in
// compileElementAccessBody. That path used to capture the `__vec_get` funcIdx
// BEFORE compiling the index expression. When the index itself lowers a dynamic
// read (e.g. `recv.length - 1`), it registers late imports that shift every
// DEFINED-function index — including `__vec_get` — so the captured index went
// stale and the `then` arm emitted `f64.convert_i32_s` on the externref
// receiver: `Invalid Wasm binary`. The fix compiles the index first, then
// resolves the funcIdxs, keeping them live through emission.
describe("#3007 any-context computed-index read funcIdx desync", () => {
  it("string index with an import-adding index expr returns the last char", async () => {
    // __s is `any` (d.toISOString() on an evolving-any binding); the index
    // `__s.length - 1` registers late imports mid-compile. Before #3007 this
    // produced invalid Wasm; now it compiles and returns the correct char.
    const ex = (await compileToWasm(
      `export function test(): any {
         var d; d = new Date(0);
         const __s = d.toISOString();
         return __s[__s.length - 1];
       }`,
    )) as { test: () => unknown };
    expect(ex.test()).toBe("Z");
  });

  it("string literal-index read still works (byte-path unchanged)", async () => {
    const ex = (await compileToWasm(`export function test(): any { const s: any = "abc"; return s[0]; }`)) as {
      test: () => unknown;
    };
    expect(ex.test()).toBe("a");
  });

  it("pre-stored index read is unaffected", async () => {
    const ex = (await compileToWasm(
      `export function test(): any {
         var d; d = new Date(0);
         const __s = d.toISOString();
         const i = __s.length - 1;
         return __s[i];
       }`,
    )) as { test: () => unknown };
    expect(ex.test()).toBe("Z");
  });

  it("native-vec receiver read via import-adding index reads the element", async () => {
    // An `any` receiver that actually carries a native vec at runtime: the
    // fast-path `then` arm (call __vec_get) must resolve correctly even when the
    // index expression `a.length - 1` registers late imports.
    const ex = (await compileToWasm(
      `export function test(): number {
         const a: any = [10, 20, 30];
         return a[a.length - 1];
       }`,
    )) as { test: () => number };
    expect(ex.test()).toBe(30);
  });

  it("plain externref object numeric read via import-adding index", async () => {
    const ex = (await compileToWasm(
      `export function test(): any {
         const o: any = { 0: "x", 1: "y", length: 2 };
         return o[o.length - 1];
       }`,
    )) as { test: () => unknown };
    expect(ex.test()).toBe("y");
  });
});
