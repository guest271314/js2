// #2979 — the native generator done-result carried `f64 0` as its absent
// `value`, so an exhausted `g.next().value` read back as a genuine number 0
// (`v === 0` was TRUE, `v === undefined` false, `v * 2 + 5` → 5) instead of
// `undefined`. The f64 carrier cannot represent undefined, so the fix stores
// the UNDEF_F64 sentinel (value-tags.ts — a signaling-NaN bit pattern JS
// arithmetic never produces) and makes the value's f64→externref crossing
// points sentinel-aware:
//   - the dynamic `.value` read returns externref, canonicalizing the sentinel
//     to the null externref (standalone's canonical undefined —
//     `__extern_is_undefined` is `ref.is_null`);
//   - the `__get_member_value` dispatcher's gen-result arm boxes
//     sentinel-aware;
//   - `__extern_is_undefined` recognizes a `$BoxedNumber` carrying the
//     sentinel bits (values boxed by sentinel-blind f64→externref sites).
// Typed f64 reads keep their fast path — the sentinel is a NaN, which is the
// spec ToNumber(undefined), so an exhausted typed read improves 0 → NaN.
//
// This is the root cause behind the #2938 no-yield relax park ("no-yield
// `.value` semantic bug") AND a live with-yield bug on main (exhausted
// generators). Native generators are standalone/wasi-only; host lanes are
// byte-identical (verified via sha256 A/B during development).
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("; ")).toBe(true);
  if (!r.success) return undefined;
  const envImports = r.imports.filter((i) => i.module === "env");
  expect(envImports, `unexpected env imports: ${envImports.map((i) => i.name).join(",")}`).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test?: () => unknown }).test?.();
}

// Exhausted with-yield generator read through the dynamic (any) path — the
// test262 harness shape (`assert.sameValue(g.next().value, undefined)`).
const exhausted = (body: string): string => `export function test(): number {
  function* foo(): any { yield 42; }
  const g: any = foo();
  g.next();
  const v: any = g.next().value;
  ${body}
}`;

describe("#2979 exhausted generator .value is undefined (dynamic read)", () => {
  it("v === undefined is true", async () => {
    expect(await runStandalone(exhausted(`return v === undefined ? 1 : 2;`))).toBe(1);
  });

  it("v == null is true (loose)", async () => {
    expect(await runStandalone(exhausted(`return v == null ? 1 : 2;`))).toBe(1);
  });

  it("v === null is false (undefined, not null)", async () => {
    expect(await runStandalone(exhausted(`return v === null ? 1 : 2;`))).toBe(2);
  });

  it("v === 0 is false (the old value-space collision)", async () => {
    expect(await runStandalone(exhausted(`return v === 0 ? 1 : 2;`))).toBe(2);
  });

  it("numeric coercion is NaN, not 0 (undefined*2+5 → NaN)", async () => {
    expect(await runStandalone(exhausted(`const n = v * 2 + 5; return n === n ? 9 : -1;`))).toBe(-1);
  });

  it("v + 1 is NaN", async () => {
    expect(await runStandalone(exhausted(`const r = v + 1; return r === r ? 1 : 0;`))).toBe(0);
  });

  it("v is falsy", async () => {
    expect(await runStandalone(exhausted(`return v ? 9 : 8;`))).toBe(8);
  });

  it("default-parameter application fires on the exhausted value", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function* foo(): any { yield 42; }
        const g: any = foo();
        g.next();
        const pick = (x: any = 7) => x;
        return pick(g.next().value);
      }`),
    ).toBe(7);
  });
});

describe("#2979 real values are NOT disturbed", () => {
  it("first .value is the yielded 42", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function* foo(): any { yield 42; }
        const g: any = foo();
        return g.next().value;
      }`),
    ).toBe(42);
  });

  it("yielded 0 stays 0 and is NOT undefined", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function* foo(): any { yield 0; }
        const g: any = foo();
        const v: any = g.next().value;
        return v === undefined ? 1 : v === 0 ? 3 : 2;
      }`),
    ).toBe(3);
  });

  it("return-arm value survives (done:true with a REAL value)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function* foo(): any { yield 1; return 7; }
        const g: any = foo();
        g.next();
        return g.next().value;
      }`),
    ).toBe(7);
  });

  it("a genuine computed NaN is NOT undefined (sentinel unforgeable)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function* foo(): any { yield 0 / 0; }
        const g: any = foo();
        const v: any = g.next().value;
        return v === undefined ? 1 : 2;
      }`),
    ).toBe(2);
  });

  it(".done still reads correctly", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function* foo(): any { yield 42; }
        const g: any = foo();
        g.next();
        return g.next().done ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("typed for-of iteration is unaffected", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function* foo() { yield 1; yield 2; yield 3; }
        let s = 0;
        for (const x of foo()) s += x;
        return s;
      }`),
    ).toBe(6);
  });
});

describe("#2979 .return() / bare return produce undefined values", () => {
  it("gen.return() with no argument → value undefined", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function* foo(): any { yield 42; }
        const g: any = foo();
        g.next();
        const v: any = g.return().value;
        return v === undefined ? 1 : 2;
      }`),
    ).toBe(1);
  });

  it("gen.return(5) keeps the real value", async () => {
    expect(
      await runStandalone(`export function test(): number {
        function* foo(): any { yield 42; }
        const g: any = foo();
        g.next();
        return g.return(5).value;
      }`),
    ).toBe(5);
  });
});
