// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #3134 — a `Promise<T>`-typed VALUE slot (local / param / field / non-async
 * return / vec element) must lower to externref on the JS-host lane, because it
 * holds a REAL promise object (a Promise builtin chain, or an activated async
 * fn's result), not the unwrapped `T`. Before the fix, `resolveWasmType`
 * unwrapped `Promise<T>` → `T` (f64) on the host/GC lane, so the declaration
 * coerced the real promise externref through `__unbox_number` → NaN (the
 * awaited value settled as NaN).
 *
 * The unwrap "worked" only for the legacy sync-fakery population (an async call
 * compiled synchronously returns the unwrapped value); externref serves that
 * case too — the value boxes via `__box_number` at the store and either
 * `__unbox_number`s back for a numeric use or assimilates through
 * `Promise_resolve` at `await`. So one rep (externref) is correct for both.
 */
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function settled<T>(p: T | Promise<T>, ms = 2000): Promise<T> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("result promise never settled")), ms)),
  ]);
}

describe("#3134 — Promise<T> value slots are externref (host lane)", () => {
  it("a local holding a Promise builtin chain awaits to its value (was NaN)", async () => {
    const e = await compileToWasm(`
      export async function main(): Promise<number> {
        const p = Promise.resolve(21).then((x: number) => x * 2);
        return await p;
      }`);
    await expect(settled(e.main())).resolves.toBe(42);
  });

  it("a local holding an activated async fn's result awaits to its value (was NaN)", async () => {
    const e = await compileToWasm(`
      async function f(): Promise<number> { return await Promise.resolve(21).then((x: number) => x * 2); }
      export async function main(): Promise<number> { const p = f(); return await p; }`);
    await expect(settled(e.main())).resolves.toBe(42);
  });

  it("a `() => Promise<number>` typed callback param preserves the real promise (was NaN)", async () => {
    const e = await compileToWasm(`
      function runTest(cb: () => Promise<number>): Promise<number> { return cb(); }
      export function main(): any {
        return runTest(async function (): Promise<number> {
          return await Promise.resolve(21).then((x: number) => x * 2);
        });
      }`);
    await expect(settled(e.main())).resolves.toBe(42);
  });

  it("SYNC-FAKERY parity: a Promise<number> local bound to a resolved-value async call still works", async () => {
    const e = await compileToWasm(`
      async function g(): Promise<number> { return 40; }
      export async function main(): Promise<number> { const a = await g(); return a + 2; }`);
    await expect(settled(e.main())).resolves.toBe(42);
  });

  it("a Promise<T> VEC ELEMENT slot is externref — the real promise survives the array (the #2967 2c class-2 rep)", async () => {
    const e = await compileToWasm(`
      export function main(): any {
        const g = async function (): Promise<number> {
          const p = Promise.resolve(40).then((x: number) => x + 0);
          const expected = [p];
          const first = await expected[0];
          const a = await Promise.resolve(2).then((x: number) => x + 0);
          return first + a;
        };
        return g();
      }`);
    await expect(settled(e.main())).resolves.toBe(42);
  });
});
