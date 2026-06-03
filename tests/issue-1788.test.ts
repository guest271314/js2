// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Issue #1788 — boolean i32 struct fields boxed as number.
 *
 * A boolean property stored in an object literal that lowers to a WasmGC
 * struct read back as a *number* through any dynamic (host-visible) access
 * path, because the struct field is a bare i32 and the field getter
 * (`__sget_<name>`) boxed it via `__box_number`. The boolean/number
 * distinction was lost: `typeof o.x` was `"number"` and `o.x === true` was
 * false.
 *
 * Fix: brand the boolean i32 ValType (`{ kind: "i32", boolean: true }`) so the
 * struct field getter forces externref/box mode and boxes via `__box_boolean`
 * instead of `__box_number`. Boolean locals / params / arithmetic keep bare
 * i32 (the brand is structurally inert for everything but the struct-field
 * boxing decision).
 */
import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

async function runWasm(src: string): Promise<unknown> {
  const exports = await compileToWasm(src);
  const fn = exports.test as () => unknown;
  return fn();
}

describe("#1788 — boolean struct field round-trips as boolean", () => {
  it('typeof ({ x: true } as any).x === "boolean"', async () => {
    expect(
      await runWasm(`
        export function test(): string {
          const o: any = { x: true };
          return typeof o.x;
        }
      `),
    ).toBe("boolean");
  });

  it("({ x: true } as any).x === true (strict equality holds)", async () => {
    expect(
      await runWasm(`
        export function test(): number {
          const o: any = { x: true };
          return o.x === true ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("({ x: false } as any).x === false (strict equality holds)", async () => {
    expect(
      await runWasm(`
        export function test(): number {
          const o: any = { x: false };
          return o.x === false ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("Array.prototype.indexOf.call({1: true, length: 2}, true) === 1 (residual #1461)", async () => {
    expect(
      await runWasm(`
        export function test(): number {
          const obj: any = { 1: true, length: 2 };
          return Array.prototype.indexOf.call(obj, true);
        }
      `),
    ).toBe(1);
  });

  it("mixed boolean + number fields each round-trip with their own type", async () => {
    expect(
      await runWasm(`
        export function test(): string {
          const o: any = { flag: true, count: 3 };
          return typeof o.flag + "," + typeof o.count;
        }
      `),
    ).toBe("boolean,number");
  });
});
