// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1729 — `<value> instanceof Object` must be true for every object value
 * (§7.3.20 OrdinaryHasInstance walks the prototype chain to
 * Object.prototype). WasmGC-struct-backed values — object literals, arrays,
 * class instances — are opaque externrefs at the host boundary, so both the
 * static `instanceof` evaluator and the runtime `__instanceof` returned a
 * spurious `false`. Surfaced via the #1720 A6_T1 "thrown value instanceof"
 * assertion (dev-c).
 *
 * Two layers fixed:
 *   - `tryStaticInstanceOf` (identifiers.ts): Object is a universal yes for
 *     object-literal / array / builtin / user-class-instance LHS types.
 *   - runtime `__instanceof` (runtime.ts): a WasmGC-struct receiver with the
 *     `Object` RHS returns 1 (covers the `any`-typed / thrown-value path).
 */
import { describe, it, expect } from "vitest";
import { compileAndInstantiate } from "../src/runtime.js";

async function run(src: string): Promise<number> {
  const exports = await compileAndInstantiate(src);
  return ((exports as any).test as () => number)();
}

describe("#1729 — instanceof Object for object values", () => {
  it.each([
    ["object literal", `const o = { x: 1 }; export function test(): number { return (o instanceof Object) ? 1 : 0; }`],
    ["array", `const a = [1, 2]; export function test(): number { return (a instanceof Object) ? 1 : 0; }`],
    [
      "class instance",
      `class C {} const c = new C(); export function test(): number { return (c instanceof Object) ? 1 : 0; }`,
    ],
    [
      "thrown object literal (caught any)",
      `export function test(): number { try { throw { x: 1 }; } catch (e) { return (e instanceof Object) ? 1 : 0; } }`,
    ],
    [
      "thrown array (caught any)",
      `export function test(): number { try { throw [1, 2]; } catch (e) { return (e instanceof Object) ? 1 : 0; } }`,
    ],
    [
      "thrown Error instanceof Object",
      `export function test(): number { try { throw new TypeError("x"); } catch (e) { return (e instanceof Object) ? 1 : 0; } }`,
    ],
  ])("%s instanceof Object is true", async (_label, src) => {
    expect(await run(src)).toBe(1);
  });

  it.each([
    [
      "thrown number",
      `export function test(): number { try { throw 5; } catch (e) { return (e instanceof Object) ? 1 : 0; } }`,
    ],
    [
      "thrown string",
      `export function test(): number { try { throw "x"; } catch (e) { return (e instanceof Object) ? 1 : 0; } }`,
    ],
  ])("%s instanceof Object is false", async (_label, src) => {
    expect(await run(src)).toBe(0);
  });

  it("array instanceof Array still true; object literal instanceof Array still false", async () => {
    expect(await run(`const a = [1, 2]; export function test(): number { return (a instanceof Array) ? 1 : 0; }`)).toBe(
      1,
    );
    expect(
      await run(`const o = { x: 1 }; export function test(): number { return (o instanceof Array) ? 1 : 0; }`),
    ).toBe(0);
  });
});
