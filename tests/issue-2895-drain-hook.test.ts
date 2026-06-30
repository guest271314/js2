// #2895 PATH B slice-1d scaffolding — the `__drain_microtasks()` compiler
// intrinsic + the test262 runner hook. The intrinsic lets the test262
// `flags:[async]` harness (and standalone entrypoints) pump the native
// microtask ring so a genuinely-pending async-frame continuation runs before a
// settled value is observed — the prerequisite for the eventual slice-1d carrier
// widen measurement (without it even a correct drive layer scores 0 — the AG0 trap).
//
// Gated on the native-`$Promise` carrier (`isStandalonePromiseActive`, wasi-only
// today → widens to standalone at slice 1d): on the host-free targets it lowers
// to the real native drain; on the gc/host lane it is a void no-op (no native
// microtask ring), keeping that lane byte-identical.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

describe("#2895 __drain_microtasks intrinsic (wasi carrier)", () => {
  it("an in-source __drain_microtasks() drives a genuinely-pending continuation", async () => {
    const src = `
let val = 0;
async function f(): Promise<number> {
  const x = await Promise.resolve(1).then((v: number) => v + 40);
  return x; // 41
}
export function run(): number {
  f().then((v: number) => { val = v; }); // suspends; continuation carries the value
  __drain_microtasks();                  // pump the ring → f resumes → .then runs → val = 41
  return val;
}
`;
    const r = await compile(src, { fileName: "t.ts", target: "wasi" });
    expect(r.success, r.success ? "" : `CE: ${r.errors?.[0]?.message}`).toBe(true);
    // Host-free: the intrinsic + carrier request no imports.
    expect((r.imports ?? []).map((i) => `${i.module}.${i.name}`)).toEqual([]);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect((instance.exports as { run(): number }).run()).toBe(41);
  });

  it("is a host-free void no-op under --target standalone (inert until slice 1d)", async () => {
    const src = `export function run(): void { __drain_microtasks(); }`;
    const r = await compile(src, { fileName: "t.ts", target: "standalone" });
    expect(r.success).toBe(true);
    expect((r.imports ?? []).length).toBe(0);
    expect(WebAssembly.validate(r.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(r.binary, {});
    expect(() => (instance.exports as { run(): void }).run()).not.toThrow();
  });
});
