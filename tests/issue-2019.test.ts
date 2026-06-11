import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// Static-property resolution family (all share the same staticProps + parent
// chain machinery):
//
// #2019 — `ClassName.staticField++` / `--` was a silent no-op (the member
//   inc/dec path had no staticProps arm, so it fell to an `f64.const NaN`
//   fallback and the write was lost). `+=` and `=` already worked.
// #2020 — inherited static fields were unreachable: `class B extends A {};
//   B.count` looked up only `B_count` and missed `A_count`.
// #2027 — `(this as any).a` in a static initializer resolved to null because
//   the static-`this` arm matched the literal `ThisKeyword` node and skipped
//   the cast wrapper. Plain `this.a` already worked.

async function evalNum(body: string): Promise<unknown> {
  const exports = await compileToWasm(body);
  return (exports as { test: () => unknown }).test();
}

describe("#2019 static property ++/--", () => {
  it("post-increment updates the static field", async () => {
    expect(await evalNum(`class A { static c = 0; } export function test(): number { A.c++; return A.c; }`)).toBe(1);
  });

  it("post-decrement updates the static field", async () => {
    expect(await evalNum(`class A { static c = 5; } export function test(): number { A.c--; return A.c; }`)).toBe(4);
  });

  it("post-increment returns the old value", async () => {
    expect(await evalNum(`class A { static c = 0; } export function test(): number { return A.c++; }`)).toBe(0);
  });

  it("pre-increment returns the new value", async () => {
    expect(await evalNum(`class A { static c = 0; } export function test(): number { return ++A.c; }`)).toBe(1);
  });

  it("does not regress `+=` on a static field", async () => {
    expect(await evalNum(`class A { static c = 0; } export function test(): number { A.c += 1; return A.c; }`)).toBe(1);
  });

  it("increments a static field from an instance method", async () => {
    expect(
      await evalNum(
        `class P { static count = 0; inc(): void { P.count++; } } export function test(): number { const p = new P(); p.inc(); p.inc(); return P.count; }`,
      ),
    ).toBe(2);
  });

  it("++ on an inherited static field writes the ancestor's global", async () => {
    expect(
      await evalNum(
        `class A { static c = 0; } class B extends A {} export function test(): number { B.c++; return A.c; }`,
      ),
    ).toBe(1);
  });
});

describe("#2020 inherited static fields", () => {
  it("reads an inherited static field through the subclass", async () => {
    expect(
      await evalNum(
        `class A { static count = 11; } class B extends A {} export function test(): number { return (B as any).count; }`,
      ),
    ).toBe(11);
  });

  it("reads an inherited static field without a cast", async () => {
    expect(
      await evalNum(
        `class A { static count = 11; } class B extends A {} export function test(): number { return B.count; }`,
      ),
    ).toBe(11);
  });

  it("walks multiple inheritance levels", async () => {
    expect(
      await evalNum(
        `class A { static count = 11; } class B extends A {} class C extends B {} export function test(): number { return C.count; }`,
      ),
    ).toBe(11);
  });

  it("own static field shadows the inherited one", async () => {
    expect(
      await evalNum(
        `class A { static count = 11; } class B extends A { static count = 22; } export function test(): number { return B.count; }`,
      ),
    ).toBe(22);
  });
});

describe("#2027 (this as any) in static initializer", () => {
  it("resolves a static field through a casted `this`", async () => {
    expect(
      await evalNum(
        `class C { static a = 1; static b = (this as any).a + 1; } export function test(): number { return C.b; }`,
      ),
    ).toBe(2);
  });

  it("does not regress plain `this` in a static initializer", async () => {
    expect(
      await evalNum(`class D { static a = 1; static b = this.a + 1; } export function test(): number { return D.b; }`),
    ).toBe(2);
  });
});
