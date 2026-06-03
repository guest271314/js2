import { describe, it, expect } from "vitest";
import { compileToWasm } from "./helpers.js";

describe("JSON.stringify", () => {
  it("stringifies a number", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        return JSON.stringify(42);
      }
    `);
    expect(exports.test()).toBe("42");
  });

  it("stringifies a string", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        return JSON.stringify("hello");
      }
    `);
    expect(exports.test()).toBe('"hello"');
  });

  it("stringifies null", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        return JSON.stringify(null);
      }
    `);
    expect(exports.test()).toBe("null");
  });

  it("stringifies a negative number", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        return JSON.stringify(-3.14);
      }
    `);
    expect(exports.test()).toBe("-3.14");
  });

  it("stringifies zero", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        return JSON.stringify(0);
      }
    `);
    expect(exports.test()).toBe("0");
  });

  // (#1788) Booleans are i32 in Wasm, but the i32 ValType is now branded
  // `boolean` so the externref coercion path boxes via `__box_boolean`, not
  // `__box_number`. JSON.stringify(true) now correctly produces "true" / "false"
  // instead of the previous "1" / "0".
  it("stringifies true", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        return JSON.stringify(true);
      }
    `);
    expect(exports.test()).toBe("true");
  });

  it("stringifies false", async () => {
    const exports = await compileToWasm(`
      export function test(): string {
        return JSON.stringify(false);
      }
    `);
    expect(exports.test()).toBe("false");
  });
});
