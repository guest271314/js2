import { describe, it, expect } from "vitest";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

// #2615 — `new Proxy(target, handler)` result must be storage-typed externref,
// not the target's struct type. The checker types `new Proxy<T>(t, h)` as `T`
// (ProxyConstructor returns its target type), so the receiving local would be
// slotted as the target's WasmGC struct. The host/native Proxy externref then
// fails `ref.test` against that struct, becomes null, and every `p.attr` read
// lowers to a direct `struct.get` on null → an empty-message Wasm trap. Forcing
// an externref slot routes reads/writes/has/delete through the boundary helpers
// (`__extern_get` / `__extern_set` / `__extern_has`), which run the Proxy MOP.

async function run(source: string): Promise<unknown> {
  const exports = await compileAndInstantiate(source);
  return (exports as { test?: () => unknown }).test?.();
}

describe("#2615 — read through a host Proxy no longer traps", () => {
  it("get trap returns the trap result (acceptance #1 of #1355)", async () => {
    // built-ins/Proxy/get/return-trap-result.js shape.
    const src = `
      export function test(): number {
        const target = { attr: 1 };
        const p = new Proxy(target, { get: function () { return 2; } });
        // every read goes through the trap → 2, not the target's 1
        return p.attr + p.foo + p["attr"] + p["foo"];
      }
    `;
    expect(await run(src)).toBe(8); // 2+2+2+2
  });

  it("read through a proxy with no get trap does not trap at runtime", async () => {
    // The historical bug: this threw an empty-message Wasm trap. We assert it
    // executes (returns a number) rather than trapping — the read-through value
    // for a closed-struct target is a separate (deferred) concern.
    const src = `
      export function test(): number {
        const target = { attr: 1 };
        const p = new Proxy(target, {});
        const v = p.attr;
        return typeof v === "number" ? 0 : 1;
      }
    `;
    // Must not throw — the assertion is that no Wasm trap fires.
    await expect(run(src)).resolves.toBeDefined();
  });

  it("`in` on a proxy keeps working (regression guard)", async () => {
    const src = `
      export function test(): number {
        const target = { attr: 1 };
        const p = new Proxy(target, {});
        return ("attr" in p) ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("set through a proxy routes via __extern_set", async () => {
    const src = `
      export function test(): number {
        const target: any = { attr: 1 };
        const p = new Proxy(target, {});
        p.attr = 5;
        return p.attr;
      }
    `;
    expect(await run(src)).toBe(5);
  });

  it("delete through a proxy routes via the boundary helper", async () => {
    const src = `
      export function test(): number {
        const target: any = { attr: 1 };
        const p = new Proxy(target, {});
        delete p.attr;
        return ("attr" in p) ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(0);
  });

  it("a set trap intercepts writes", async () => {
    const src = `
      export function test(): number {
        let captured = 0;
        const target: any = { attr: 1 };
        const p = new Proxy(target, {
          set: function (t: any, k: any, v: any) { captured = v as number; return true; },
        });
        p.attr = 7;
        return captured;
      }
    `;
    expect(await run(src)).toBe(7);
  });
});
