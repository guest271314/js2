import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// #1727 — internal call to an async function consumed as a primitive value
// (`f() as unknown as number`) must NOT round-trip through
// box → Promise.resolve → unbox (which yields Number(Promise{42}) === NaN).
// The export boundary already returns the raw value; the internal call must
// match it when the result is consumed via a non-Promise cast/assertion sink.
// Genuine Promise consumers (`.then`, `const p: Promise<T>`) must STILL wrap.
describe("#1727 internal async-call result consumed as value", () => {
  it("export-vs-internal divergence: both f() and main() return 42", async () => {
    const src = `
      export async function f(): Promise<number> { return 42; }
      export function main(): number { return f() as unknown as number; }
    `;
    const exports = await compileToWasm(src);
    // The export wrapper path was always correct.
    expect((exports.f as () => unknown)()).toBe(42);
    // The internal-call path used to return NaN.
    expect(exports.main()).toBe(42);
  });

  it("as any cast sink returns the value (not NaN)", async () => {
    const src = `
      async function add(a: number, b: number): Promise<number> { return a + b; }
      export function main(): number { return add(10, 32) as any; }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(42);
  });

  it("value flows into arithmetic through a cast", async () => {
    const src = `
      async function f(): Promise<number> { return 21; }
      export function main(): number { return (f() as any as number) * 2; }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(42);
  });

  it("await consumer still works (raw-T passthrough preserved)", async () => {
    const src = `
      async function getValue(): Promise<number> { return 100; }
      async function test(): Promise<number> { const v = await getValue(); return v; }
      export function main(): number { return test() as any as number; }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(100);
  });

  it("non-cast Promise consumer still wraps (does NOT over-broaden the skip)", async () => {
    // Guard against over-broadening: with NO non-Promise cast on the call, the
    // wrap MUST still fire (producing a real Promise object). The narrow gate
    // keys on an explicit non-Promise cast/assertion. Here `p` is declared as a
    // genuine `Promise<number>`, so the wrap fires; coercing the Promise object
    // to a number unboxes `Number(Promise{7})` === NaN. We assert NaN to prove
    // the Promise wrap was NOT skipped for a non-cast consumer.
    const src = `
      async function f(): Promise<number> { return 7; }
      export function main(): number {
        const p: Promise<number> = f();
        return p as unknown as number;
      }
    `;
    const exports = await compileToWasm(src);
    // NaN iff the wrap still fired (Promise object) — i.e. the skip did not
    // over-broaden. A real value here would mean we wrongly skipped the wrap.
    expect(Number.isNaN(exports.main() as number)).toBe(true);
  });

  it("Promise<void> async fn consumed as value does not corrupt the stack", async () => {
    const src = `
      let sideEffect = 0;
      async function doThing(): Promise<void> { sideEffect = 5; }
      export function main(): number {
        doThing() as any;
        return sideEffect;
      }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(5);
  });
});
