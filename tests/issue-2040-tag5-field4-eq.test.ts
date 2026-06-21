import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

// #2040/#2585 — unified tag-5 field-4 equality classifier.
//
// The tag-5 (string) box's `externval` (field 4 of $AnyValue) is overloaded: it
// holds genuine strings, `$BoxedNumber`s (the #1888 −794 "box-the-externref"
// contract for numbers that pass through externref), and object/proto refs. The
// tag-5 arm of both __any_eq and __any_strict_eq used to unconditionally run
// string-eq on the two field-4 externrefs, which (with #2583's native string arm)
// `ref.cast $AnyString` on a non-string → TRAPS, and otherwise mis-compares:
//   - two boxed numbers → `a !== a` wrongly true / 23===23.0 wrongly false (#2040)
//   - two object refs → identity lost (#2585 proto-identity)
// The 3-way classifier picks: numeric (__any_to_f64 + f64.eq) when either field-4
// is a $BoxedNumber, string-content when both are strings, ref.eq when both are
// internal GC eqref objects.

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" } as never);
  if (!r.success) throw new Error("compile error: " + (r.errors?.[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { main(): unknown }).main();
}

describe("#2040/#2585 unified tag-5 field-4 equality classifier (standalone)", () => {
  // ── #2040 numeric branch ──────────────────────────────────────────────
  it("23 === 23.0 across any boxes is true", async () => {
    expect(
      await runStandalone(`export function main(): number { const a:any=23; const b:any=23.0; return (a===b)?1:0; }`),
    ).toBe(1);
  });

  it("a !== a after a numeric op is false (a is a number, ===itself)", async () => {
    // 1/a forces `a` through the boxed-number tag-5 path; a!==a must be false.
    expect(
      await runStandalone(
        `function f(a:any){const _=1/a;return a!==a;} export function main(): number { return f(5)?1:0; }`,
      ),
    ).toBe(0);
  });

  it("boxed-number === boxed-number (post-op) is true", async () => {
    expect(
      await runStandalone(
        `function f(a:any,b:any){const x=a+0;const y=b+0;return x===y;} export function main(): number { return f(7,7)?1:0; }`,
      ),
    ).toBe(1);
  });

  it("(1/a) === (1/b) for equal a,b is true", async () => {
    expect(
      await runStandalone(
        `function f(a:any,b:any){return (1/a)===(1/b);} export function main(): number { return f(2,2)?1:0; }`,
      ),
    ).toBe(1);
  });

  // ── NaN contract (−788 preserved): NaN === NaN stays false ────────────
  it("NaN === NaN via any boxes is false (f64.eq self-false)", async () => {
    expect(
      await runStandalone(`export function main(): number { const a:any=NaN; const b:any=NaN; return (a===b)?1:0; }`),
    ).toBe(0);
  });

  it("NaN !== NaN is true", async () => {
    expect(await runStandalone(`export function main(): number { const a:any=NaN; return (a!==a)?1:0; }`)).toBe(1);
  });

  it("+0 === -0 is true", async () => {
    expect(
      await runStandalone(`export function main(): number { const a:any=0; const b:any=-0; return (a===b)?1:0; }`),
    ).toBe(1);
  });

  it("1 === 2 via any boxes is false", async () => {
    expect(
      await runStandalone(`export function main(): number { const a:any=1; const b:any=2; return (a===b)?1:0; }`),
    ).toBe(0);
  });

  // ── #2585 object proto-identity (ref.eq branch) ───────────────────────
  it("getPrototypeOf(Object.create(p)) === p is true", async () => {
    expect(
      await runStandalone(
        `export function main(): number { const p:any={x:1}; const o=Object.create(p); return (Object.getPrototypeOf(o)===p)?1:0; }`,
      ),
    ).toBe(1);
  });

  it("same object via two reads === is true", async () => {
    expect(
      await runStandalone(`export function main(): number { const o:any={x:1}; const p:any=o; return (o===p)?1:0; }`),
    ).toBe(1);
  });

  it("two distinct objects === is false", async () => {
    expect(
      await runStandalone(
        `export function main(): number { const o:any={x:1}; const p:any={x:1}; return (o===p)?1:0; }`,
      ),
    ).toBe(0);
  });

  // ── loose-eq numeric (cross-tag arm tolerates boxed-number field-4) ───
  it("23 == 23.0 via any boxes is true (loose)", async () => {
    expect(
      await runStandalone(`export function main(): number { const a:any=23; const b:any=23.0; return (a==b)?1:0; }`),
    ).toBe(1);
  });
});
