// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2865 AG0 — host-free standalone `await` on the native `$Promise` carrier.
 *
 * Under `--target standalone` (and WASI) there is no JS host microtask queue, so
 * the async-CPS state machine is gated off and async functions are compiled
 * SYNCHRONOUSLY (the result type is the unwrapped value). Before AG0 the `await`
 * expression was a pure identity passthrough: `await <fulfilled $Promise>`
 * returned the promise OBJECT where the consumer expected the resolved value, so
 * a numeric awaiter coerced the externref to f64 → NaN. AG0 also extends
 * `isStandalonePromiseActive` to cover `ctx.standalone` so `Promise.resolve` /
 * `.then` stop leaking `env::Promise_*` host imports under `--target standalone`.
 *
 * This slice covers the dominant SYNCHRONOUSLY-SETTLED subset: `await
 * Promise.resolve(x)`, `await <literal>`, and `await <a sync-fulfilled promise>`.
 * `await` now reads one level of the native `$Promise.value` field at runtime
 * (guarded by a `ref.test (ref $Promise)`), so non-Promise operands pass through
 * unchanged. Genuinely-pending awaits (a promise that only settles on a later
 * microtask) need true frame suspension — deferred to AG1 (PATH B).
 *
 * Every case compiles standalone with ZERO host imports and returns the correct
 * resolved value (no NaN).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2865 AG0 standalone host-free await unwrap", () => {
  it("verify-first: `return await Promise.resolve(5)` host-free, no NaN", async () => {
    expect(
      await runStandalone(`async function f(): Promise<number> { return await Promise.resolve(5); }
export function test(): number { return (f() as unknown as number); }`),
    ).toBe(5);
  });

  it("`const x = await Promise.resolve(40); return x + 2`", async () => {
    expect(
      await runStandalone(`async function f(): Promise<number> { const x = await Promise.resolve(40); return x + 2; }
export function test(): number { return (f() as unknown as number); }`),
    ).toBe(42);
  });

  it("await a sync-fulfilled local promise", async () => {
    expect(
      await runStandalone(`async function f(): Promise<number> { let p = Promise.resolve(7); return await p; }
export function test(): number { return (f() as unknown as number); }`),
    ).toBe(7);
  });

  it("await over a numeric literal passes through (non-Promise operand)", async () => {
    expect(
      await runStandalone(`async function f(): Promise<number> { return await 99; }
export function test(): number { return (f() as unknown as number); }`),
    ).toBe(99);
  });

  it("await over an arithmetic expression passes through", async () => {
    expect(
      await runStandalone(`async function f(): Promise<number> { let n = 8; return await (n + 1); }
export function test(): number { return (f() as unknown as number); }`),
    ).toBe(9);
  });

  it("async METHOD awaits a fulfilled promise host-free", async () => {
    expect(
      await runStandalone(`class C { async m(): Promise<number> { return await Promise.resolve(11); } }
export function test(): number { const c = new C(); return (c.m() as unknown as number); }`),
    ).toBe(11);
  });

  it("two sequential awaits accumulate the resolved values", async () => {
    expect(
      await runStandalone(`async function f(): Promise<number> {
  const a = await Promise.resolve(3);
  const b = await Promise.resolve(4);
  return a * 10 + b;
}
export function test(): number { return (f() as unknown as number); }`),
    ).toBe(34);
  });
});
