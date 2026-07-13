import { describe, it, expect } from "vitest";
import { compileAndRunImportObject as compileAndRun } from "./helpers/compile.js";

// #2062 — `catch (e) { e = ...; throw e; }` used to emit Wasm `rethrow`, which
// re-raises the ORIGINALLY-caught exception, ignoring the reassignment. The
// rethrow fast path is now disabled whenever the catch parameter is written
// anywhere in the block (assignment, compound, ++/--, or via a capturing
// closure); plain `catch (e) { throw e; }` keeps the fast path.

describe("#2062 throw e after catch-param reassignment", () => {
  it("reassign then throw propagates the new value", async () => {
    const e = await compileAndRun(
      `export function f(): number {
         try { try { throw 1; } catch (e) { e = 2; throw e; } }
         catch (e2) { return (e2 as number) * 10; }
         return -1;
       }`,
    );
    expect(e.f()).toBe(20);
  });

  it("compound assignment to catch param", async () => {
    const e = await compileAndRun(
      `export function f(): number {
         try { try { throw 3; } catch (e) { e = (e as number) + 7; throw e; } }
         catch (e2) { return (e2 as number); }
         return -1;
       }`,
    );
    expect(e.f()).toBe(10);
  });

  it("reassignment inside a capturing closure", async () => {
    const e = await compileAndRun(
      `export function f(): number {
         try { try { throw 1; } catch (e) { const g = () => { e = 2; }; g(); throw e; } }
         catch (e2) { return (e2 as number) * 10; }
         return -1;
       }`,
    );
    expect(e.f()).toBe(20);
  });

  it("reassign then rethrow from a nested block", async () => {
    const e = await compileAndRun(
      `export function f(): number {
         try { try { throw 8; } catch (e) { e = 99; if (true) { throw e; } } }
         catch (e2) { return (e2 as number); }
         return -1;
       }`,
    );
    expect(e.f()).toBe(99);
  });

  it("plain rethrow keeps the fast path (unregressed)", async () => {
    const e = await compileAndRun(
      `export function f(): number {
         try { try { throw 42; } catch (e) { throw e; } }
         catch (e2) { return (e2 as number); }
         return -1;
       }`,
    );
    expect(e.f()).toBe(42);
  });

  it("plain rethrow from a nested block keeps the fast path", async () => {
    const e = await compileAndRun(
      `export function f(): number {
         try { try { throw 8; } catch (e) { if (true) { throw e; } } }
         catch (e2) { return (e2 as number); }
         return -1;
       }`,
    );
    expect(e.f()).toBe(8);
  });
});
