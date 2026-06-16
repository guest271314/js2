// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2151 Slice 2 — N-ary any-receiver method dispatch on closed object-literal
 * structs in standalone / WASI.
 *
 * Slice 1 (#1463, merged) handled 0-arg any-receiver method calls via the
 * `__call_m_<name>` closed-struct dispatcher. Methods invoked WITH arguments
 * (`o.add(5)`, `o.sum(2,3)`) fell through to the host path → wrong value / NaN
 * standalone. This slice arity-specializes the dispatcher
 * (`__call_m_<name>_<arity>(recv, arg0..argK)`, all externref): the call site
 * boxes each argument to externref, the dispatcher unboxes each back to the
 * method's declared param type per candidate struct (`__unbox_number` /
 * `__unbox_boolean` / cast), threads the struct as `this`, and box-coerces the
 * result.
 *
 * Every case compiles standalone with ZERO host imports.
 *
 * NOTE: method names that collide with a built-in (`add` → Set.prototype.add,
 * `push`, etc.) still route to the builtin fast-path *before* the any-receiver
 * fallback — a pre-existing builtin-method-name precedence issue, NOT part of
 * this slice. The tests use non-colliding names.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string, target: "standalone" | "wasi" = "standalone"): Promise<number> {
  const r = await compile(src, { fileName: "test.ts", target });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  if (target === "standalone") {
    const mod = await WebAssembly.compile(r.binary);
    const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
    expect(imports, "standalone module must have zero host imports").toEqual([]);
  }
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2151 Slice 2 — N-ary any-receiver method dispatch (standalone)", () => {
  it("1-arg method", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o: any = { f(n: number) { return n + 4; } }; return o.f(5); }`,
      ),
    ).toBe(9);
  });

  it("2-arg method", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o: any = { g(a: number, b: number) { return a * b + 2; } }; return o.g(3, 4); }`,
      ),
    ).toBe(14);
  });

  it("3-arg method", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o: any = { h(a: number, b: number, c: number) { return a + b + c; } }; return o.h(1, 2, 3); }`,
      ),
    ).toBe(6);
  });

  it("method using this + arg", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o: any = { base: 20, plus(n: number) { return this.base + n; } }; return o.plus(5); }`,
      ),
    ).toBe(25);
  });

  it("0-arg path still works (Slice 1 regression)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const o: any = { next() { return 7; } }; return o.next(); }`,
      ),
    ).toBe(7);
  });

  it("wasi: 1-arg method", async () => {
    const r = await compile(
      `export function test(): number { const o: any = { f(n: number) { return n + 4; } }; return o.f(5); }`,
      { target: "wasi" },
    );
    expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { test(): number }).test()).toBe(9);
  });
});
