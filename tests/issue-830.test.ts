/**
 * Issue #830 — DisposableStack extern class missing (38 wasm_compile failures)
 *
 * Root cause: DisposableStack (TC39 Explicit Resource Management, stage 3)
 * was not in the builtinCtors map in runtime.ts, so WebAssembly instantiation
 * failed with "No dependency provided for extern class 'DisposableStack'".
 *
 * Fix: Added DisposableStack, AsyncDisposableStack, and SuppressedError to
 * builtinCtors with a conditional check (typeof X !== "undefined") so the
 * runtime works gracefully on older Node.js that may not have them.
 */
import { describe, it, expect } from "vitest";
import { compileAndRunResultObject } from "./helpers/compile.js";

const compileAndRun = (src: string) => compileAndRunResultObject(src, true);

describe("Issue #830: DisposableStack host import", () => {
  it("DisposableStack can be constructed (no CE)", async () => {
    const r = await compileAndRun(`
      export function test(): number {
        const stack = new DisposableStack();
        return 1;
      }
    `);
    if (r.error) expect(r.error).not.toMatch(/No dependency provided/);
    expect(r.success).toBe(true);
  });

  it("DisposableStack.disposed starts false", async () => {
    const r = await compileAndRun(`
      export function test(): number {
        const stack = new DisposableStack();
        return stack.disposed === false ? 1 : 0;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("DisposableStack.disposed is true after dispose()", async () => {
    const r = await compileAndRun(`
      export function test(): number {
        const stack = new DisposableStack();
        stack.dispose();
        return stack.disposed === true ? 1 : 0;
      }
    `);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });

  it("SuppressedError can be constructed (no CE)", async () => {
    const r = await compileAndRun(`
      export function test(): number {
        const e = new SuppressedError(new Error("a"), new Error("b"));
        return e instanceof SuppressedError ? 1 : 0;
      }
    `);
    if (r.error) expect(r.error).not.toMatch(/No dependency provided/);
    expect(r.success).toBe(true);
    expect(r.result).toBe(1);
  });
});
