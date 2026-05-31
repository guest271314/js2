import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// #1730 — calling a module-level `const`-bound arrow internally (wasm `call_ref`
// dispatch, not the export boundary) used to trap with "illegal cast". A late
// string-constant import added while compiling the call arguments shifted every
// module-global index, but the funcref re-resolution in `compileClosureCall`
// reused a stale captured `moduleIdx`, emitting a `global.get` that pointed at
// the late import global instead of the closure's `__mod_<name>`. The cast of
// that string externref to the closure struct trapped. Fixed by re-reading
// `ctx.moduleGlobals` on each closure-ref push.
describe("#1730 module-level const arrow internal call", () => {
  it("direct call to a sync module-const arrow returns the right value", async () => {
    const src = `
      const f = (x: number): number => x * 2;
      export function main(): number { return f(21); }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(42);
  });

  it("intermediate-local alias still works (regression control)", async () => {
    const src = `
      const f = (x: number): number => x * 2;
      export function main(): number { const g = f; return g(21); }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(42);
  });

  it("async module-const arrow called internally returns the awaited value", async () => {
    const src = `
      const double = async (x: number): Promise<number> => x * 2;
      export function main(): number { return double(21) as any as number; }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(42);
  });

  it("two distinct module-const arrows called internally", async () => {
    const src = `
      const f = (x: number): number => x * 2;
      const g = (x: number): number => x + 100;
      export function main(): number { return f(21) + g(0); }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(142);
  });

  it("module-const arrow called more than once", async () => {
    const src = `
      const f = (x: number): number => x * 2;
      export function main(): number { return f(10) + f(11); }
    `;
    const exports = await compileToWasm(src);
    expect(exports.main()).toBe(42);
  });
});
