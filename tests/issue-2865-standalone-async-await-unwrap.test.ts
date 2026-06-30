// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2865 AG0 — host-free `await` on the native `$Promise` carrier (WASI).
 *
 * Under `--target wasi` there is no JS host microtask queue, so the async-CPS
 * state machine is gated off and async functions are compiled SYNCHRONOUSLY (the
 * result type is the unwrapped value). Before AG0 the `await` expression was a
 * pure identity passthrough: `await <fulfilled $Promise>` returned the promise
 * OBJECT where the consumer expected the resolved value, so a numeric awaiter
 * coerced the externref to f64 → NaN. AG0 reads one level of the native
 * `$Promise.value` field at runtime (guarded by a `ref.test (ref $Promise)`), so
 * non-Promise operands pass through unchanged.
 *
 * SCOPE NOTE (#2895 reconcile): AG0 originally also widened the gate to
 * `--target standalone`, but ground-truth measurement showed that is a net
 * REGRESSION there (the `flags:[async]` test262 harness can't drain a native
 * standalone async result without PATH B's drive layer). So host-free await is
 * scoped to WASI here; the standalone version is PATH B (#2895). These cases
 * therefore exercise the **WASI** target, where the carrier is host-free.
 *
 * Every case compiles WASI with ZERO host imports and returns the correct
 * resolved value (no NaN).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runWasi(src: string): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target: "wasi" });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2865 AG0 host-free await unwrap (WASI)", () => {
  it("verify-first: `return await Promise.resolve(5)` host-free, no NaN", async () => {
    expect(
      await runWasi(`async function f(): Promise<number> { return await Promise.resolve(5); }
export function test(): number { return (f() as unknown as number); }`),
    ).toBe(5);
  });

  it("`const x = await Promise.resolve(40); return x + 2`", async () => {
    expect(
      await runWasi(`async function f(): Promise<number> { const x = await Promise.resolve(40); return x + 2; }
export function test(): number { return (f() as unknown as number); }`),
    ).toBe(42);
  });

  it("await a sync-fulfilled local promise", async () => {
    expect(
      await runWasi(`async function f(): Promise<number> { let p = Promise.resolve(7); return await p; }
export function test(): number { return (f() as unknown as number); }`),
    ).toBe(7);
  });

  it("await over a numeric literal passes through (non-Promise operand)", async () => {
    expect(
      await runWasi(`async function f(): Promise<number> { return await 99; }
export function test(): number { return (f() as unknown as number); }`),
    ).toBe(99);
  });

  it("await over an arithmetic expression passes through", async () => {
    expect(
      await runWasi(`async function f(): Promise<number> { let n = 8; return await (n + 1); }
export function test(): number { return (f() as unknown as number); }`),
    ).toBe(9);
  });

  it("async METHOD awaits a fulfilled promise host-free", async () => {
    expect(
      await runWasi(`class C { async m(): Promise<number> { return await Promise.resolve(11); } }
export function test(): number { const c = new C(); return (c.m() as unknown as number); }`),
    ).toBe(11);
  });

  it("two sequential awaits accumulate the resolved values", async () => {
    expect(
      await runWasi(`async function f(): Promise<number> {
  const a = await Promise.resolve(3);
  const b = await Promise.resolve(4);
  return a * 10 + b;
}
export function test(): number { return (f() as unknown as number); }`),
    ).toBe(34);
  });
});
