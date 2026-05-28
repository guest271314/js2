import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// #1644 Slice D — BigInt.prototype.toString(radix).
//
// Per §21.2.3.4: BigInt.prototype.toString returns a string in base `radix`
// (2-36, default 10). Bigint-typed receivers cross the Wasm boundary as i64;
// the codegen routes to `bigint_toString` / `bigint_toString_radix` host
// imports that delegate to the spec-compliant V8 `BigInt.prototype.toString`.
// Out-of-range radix throws RangeError, mirroring the number_toString_radix
// validation gate.
describe("#1644 Slice D — bigint.prototype.toString(radix)", () => {
  it("bigint-typed receiver, no radix → base 10", async () => {
    const exports = await compileToWasm(`
      export function test(): any {
        const x: bigint = 255n;
        return x.toString();
      }
    `);
    expect(exports.test()).toBe("255");
  });

  it("bigint-typed receiver, radix 16", async () => {
    const exports = await compileToWasm(`
      export function test(): any {
        const x: bigint = 255n;
        return x.toString(16);
      }
    `);
    expect(exports.test()).toBe("ff");
  });

  it("bigint-typed receiver, radix 2", async () => {
    const exports = await compileToWasm(`
      export function test(): any {
        const x: bigint = 10n;
        return x.toString(2);
      }
    `);
    expect(exports.test()).toBe("1010");
  });

  it("bigint-typed receiver, radix 36", async () => {
    const exports = await compileToWasm(`
      export function test(): any {
        const x: bigint = 1295n;
        return x.toString(36);
      }
    `);
    expect(exports.test()).toBe("zz");
  });

  it("radix < 2 throws RangeError", async () => {
    const exports = await compileToWasm(`
      export function test(): any {
        const x: bigint = 10n;
        try { return x.toString(1); } catch (e: any) { return "THREW"; }
      }
    `);
    expect(exports.test()).toBe("THREW");
  });

  it("radix > 36 throws RangeError", async () => {
    const exports = await compileToWasm(`
      export function test(): any {
        const x: bigint = 10n;
        try { return x.toString(37); } catch (e: any) { return "THREW"; }
      }
    `);
    expect(exports.test()).toBe("THREW");
  });

  it("regression: number.toString still works (no cross-talk)", async () => {
    const exports = await compileToWasm(`
      export function test(): any {
        return (255).toString(16);
      }
    `);
    expect(exports.test()).toBe("ff");
  });
});
