// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3100 S4 — iterator-consumer migration onto the native standalone substrate:
 * retire the `env::__array_from_iter_n` / `env::__extern_slice` /
 * `env::__iterator*` host-import leaks at a single ensureLateImport chokepoint.
 *
 * Before this slice, the ASSIGNMENT array-destructure consumer
 * (`[a, b] = <any>`) called `ensureLateImport("__array_from_iter_n")` with no
 * standalone gate — the name was neither natively routed nor refused, so the
 * module leaked `env::__array_from_iter_n` and failed zero-import
 * instantiation (the 60-row `language/expressions/assignment/dstr` cluster of
 * the standalone JSONL). Rest elements leaked `env::__extern_slice` the same
 * way (raw `addImport` at four consumer sites).
 *
 * The fix (one chokepoint + one consumer + one new native helper):
 *   - `ensureLateImport` routes `__iterator{,_next,_return,_rest}` →
 *     `ensureNativeIteratorRuntime`, `__array_from_iter_n` →
 *     `ensureNativeArrayFromIterN` (#2904), and `__extern_slice` →
 *     `ensureNativeExternSlice` (NEW) under standalone/wasi.
 *   - `ensureNativeExternSlice` — an index-based rest slice over the native
 *     read substrate (`__extern_length` / `__extern_get_idx` carrier arms),
 *     with an `$AnyString` arm via the #1470 `__str_to_char_vec` helper.
 *   - the assignment consumer reads elements via the carrier-aware
 *     `__extern_get_idx(mat, f64 i)` standalone (the native string-keyed
 *     `__extern_get` would miss on every vec carrier).
 *   - `const [a, ...rest] = "hello"` builds the rest NATIVELY as a `string[]`
 *     nstrVec (per code point, §22.1.5.1) — the old externref slice could
 *     never satisfy the typed rest local (`ref.cast $nstrVec` → illegal cast
 *     in BOTH modes).
 *
 * Every fix case compiles standalone and must instantiate with ZERO host
 * imports. Host-lane byte-identity is proven separately (15-program corpus).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary!);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary!, {});
  return (instance.exports as { test(): number }).test();
}

describe("#3100 S4 — assignment array-destructure from `any` (the __array_from_iter_n leak)", () => {
  it("verify-first: [a, b] = <any> — the 60-row assignment/dstr cluster shape", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = [1, 2, 3];
        let a = 0, b = 0;
        [a, b] = o;
        return a + b;
      }`),
    ).toBe(3);
  });

  it("[a, ...r] = <any> — rest via the native __extern_slice", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = [1, 2, 3];
        let a = 0;
        let r: any = null;
        [a, ...r] = o;
        return a + r.length;
      }`),
    ).toBe(3);
  });

  it("rest slice content: canonical-vec elements read back", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let a: any = null;
        let r: any = null;
        [a, ...r] = ([1, 2, 3] as any);
        return r[0] + r[1];
      }`),
    ).toBe(5);
  });

  it("rest slice OOB read is undefined (strict-eq arm)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let a: any = null;
        let r: any = null;
        [a, ...r] = ([1, 2, 3] as any);
        return r[9] === undefined ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("[a, b] = Object.keys(<any>) — $ObjVec carrier through the same consumer", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { x: 1, y: 2 };
        let a: any = null;
        let b: any = null;
        [a, b] = Object.keys(o);
        return (a as string).length + (b as string).length;
      }`),
    ).toBe(2);
  });

  it("element default fires on short source ([a = 9] = <any-empty>)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = [];
        let a = 0;
        [a = 9] = o;
        return a;
      }`),
    ).toBe(9);
  });

  it("assignment-dstr content correctness (string key compare)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { xx: 1 };
        let a = "";
        [a] = Object.keys(o);
        return a === "xx" ? 1 : 0;
      }`),
    ).toBe(1);
  });
});

describe("#3100 S4 — string rest destructuring (native nstrVec tail, was illegal cast)", () => {
  it("const [a, ...r] = 'hello' — a is 'h'", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const [a, ...r] = "hello";
        return a === "h" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("const [a, ...r] = 'hello' — r has the 4 remaining code points", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const [a, ...r] = "hello";
        const rr: any = r;
        return rr.length;
      }`),
    ).toBe(4);
  });

  it("string rest content: r[0] === 'e'", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const [a, ...r] = "hello";
        return r[0] === "e" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("short source: rest beyond length is empty, no trap", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const [a, b, c, ...r] = "x";
        const rr: any = r;
        return rr.length;
      }`),
    ).toBe(0);
  });
});

describe("#3100 S4 — regression guards (paths that already worked stay working)", () => {
  it("DECL const [a, b] = <any> (was already native via #2904)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = [1, 2, 3];
        const [a, b] = o;
        return a + b;
      }`),
    ).toBe(3);
  });

  it("spread [...<any>] (S1 substrate)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = [1, 2, 3];
        const c = [...o];
        return c.length;
      }`),
    ).toBe(3);
  });

  it("Array.from(<any>) (S1 substrate)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = [1, 2, 3];
        const c = Array.from(o);
        return c.length;
      }`),
    ).toBe(3);
  });

  it("for-of over Object.keys(<any>) (S1 primary probe)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { a: 5, b: 6 };
        let n = 0;
        for (const k of Object.keys(o)) { n += 1; }
        return n;
      }`),
    ).toBe(2);
  });

  it("no-rest string destructure (charAt fast path untouched)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const [a, b] = "hello";
        return a === "h" && b === "e" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("for-of assignment-form vec rest (native tail copy, #2602)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let x = 0;
        let y: any = null;
        for ([x, ...y] of [[1, 2, 3]]) { }
        return x + y.length;
      }`),
    ).toBe(3);
  });
});
