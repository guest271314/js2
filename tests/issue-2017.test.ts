import { describe, it, expect } from "vitest";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

// (#2017) Writing to a getter-only object-literal property used to silently
// no-op (and, earlier, trap "illegal cast") instead of throwing the strict-mode
// TypeError the spec mandates (§13.15.2 → §10.1.9 OrdinarySetWithOwnDescriptor:
// an accessor with no [[Set]] → throw in strict code; ESM is always strict).
// The fix routes accessor-detected property writes through a strict host setter
// (`__extern_set_strict`) that throws a CATCHABLE TypeError; getter+setter pairs
// and ordinary writable properties are unaffected.

async function run<T = unknown>(src: string, fn: string): Promise<T> {
  const exports = (await compileAndInstantiate(src)) as Record<string, () => T>;
  return exports[fn]!();
}

describe("#2017 getter-only assignment", () => {
  it("assigning a getter-only object-literal property throws a catchable TypeError", async () => {
    const src = `
      const o: any = { get x() { return 1; } };
      export function t(): string {
        try { o.x = 99; return "set:" + o.x; } catch (e) { return "threw"; }
      }
    `;
    expect(await run<string>(src, "t")).toBe("threw");
  });

  it("getter+setter pair still routes the write to the setter", async () => {
    const src = `
      let store = 0;
      const o: any = { get x() { return store; }, set x(v: number) { store = v; } };
      export function t(): number { o.x = 42; return o.x; }
    `;
    expect(await run<number>(src, "t")).toBe(42);
  });

  it("the getter still returns its value after a rejected write", async () => {
    const src = `
      const o: any = { get x() { return 7; } };
      export function t(): number {
        try { o.x = 99; } catch (e) { /* swallow */ }
        return o.x;
      }
    `;
    expect(await run<number>(src, "t")).toBe(7);
  });

  it("the thrown error is a TypeError instance", async () => {
    const src = `
      const o: any = { get x() { return 1; } };
      export function t(): string {
        try { o.x = 5; return "no-throw"; }
        catch (e) { return (e instanceof TypeError) ? "TypeError" : "other"; }
      }
    `;
    expect(await run<string>(src, "t")).toBe("TypeError");
  });
});
