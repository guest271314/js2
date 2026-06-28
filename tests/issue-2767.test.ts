import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

// #2767 — a nominal value assigned into an uninitialized / untyped `var`/`let`
// binding loses its nominal type, so method dispatch on it fell to the generic
// dynamic path and threw "<method> is not a function". The TS checker reports
// `any` for the evolving-any binding (it does NOT narrow the assigned `Date`
// type across statements), so `compileCallExpression`'s dispatch hub now
// recovers the effective nominal type by scanning the binding's assignments
// (`resolveAssignedNominalType`) when ALL of them agree on one nominal symbol.
//
// This is the structural fix for the `Date.prototype.toISOString` bare-`var`
// test262 cluster (flips 15.9.5.43-0-11/-12) and generalizes to any native
// builtin method receiver (DataView shown below).
describe("#2767 bare-var nominal receiver method dispatch", () => {
  const lastChar = (src: string) =>
    `export function test(): any { ${src} const __s = d.toISOString(); return __s[__s.length - 1]; }`;

  it("typed const receiver still works (unchanged)", async () => {
    const ex = (await compileToWasm(lastChar("const d = new Date(0);"))) as { test: () => unknown };
    expect(ex.test()).toBe("Z");
  });

  it("bare `var d; d = new Date(0)` dispatches (was 'not a function')", async () => {
    const ex = (await compileToWasm(lastChar("var d; d = new Date(0);"))) as { test: () => unknown };
    expect(ex.test()).toBe("Z");
  });

  it("annotated `var d: any; d = new Date(0)` dispatches", async () => {
    const ex = (await compileToWasm(lastChar("var d: any; d = new Date(0);"))) as { test: () => unknown };
    expect(ex.test()).toBe("Z");
  });

  it("`let d; d = new Date(0)` dispatches", async () => {
    const ex = (await compileToWasm(lastChar("let d; d = new Date(0);"))) as { test: () => unknown };
    expect(ex.test()).toBe("Z");
  });

  it("multi-declarator `var d, x; d = new Date(0)` dispatches", async () => {
    const ex = (await compileToWasm(lastChar("var d, x; d = new Date(0);"))) as { test: () => unknown };
    expect(ex.test()).toBe("Z");
  });

  it("conditional assignment `var d; if (true) { d = new Date(0); }` dispatches", async () => {
    const ex = (await compileToWasm(lastChar("var d; if (true) { d = new Date(0); }"))) as { test: () => unknown };
    expect(ex.test()).toBe("Z");
  });

  it("reassignment to the same nominal type still engages", async () => {
    const ex = (await compileToWasm(lastChar("var d; d = new Date(1000); d = new Date(0);"))) as {
      test: () => unknown;
    };
    expect(ex.test()).toBe("Z");
  });

  it("getTime() on a bare-var Date returns the timestamp", async () => {
    const ex = (await compileToWasm(
      `export function test(): number { var d; d = new Date(0); return d.getTime(); }`,
    )) as { test: () => number };
    expect(ex.test()).toBe(0);
  });

  it("generalizes to DataView method dispatch via a bare var", async () => {
    const ex = (await compileToWasm(
      `export function test(): number { var dv; dv = new DataView(new ArrayBuffer(8)); dv.setInt32(0, 42); return dv.getInt32(0); }`,
    )) as { test: () => number };
    expect(ex.test()).toBe(42);
  });

  // --- safety / no-misdispatch guards (the conservative all-assignments-agree rule) ---

  it("does NOT regress generic any-object-literal method dispatch", async () => {
    const ex = (await compileToWasm(
      `export function test(): number { const o: any = { m() { return 7; } }; return o.m(); }`,
    )) as { test: () => number };
    expect(ex.test()).toBe(7);
  });

  it("divergent nominal assignments bail to dynamic (no misdispatch)", async () => {
    // d is Date | RegExp → union → resolveAssignedNominalType returns undefined,
    // so the receiver stays dynamic. Both branches are objects → typeof "object".
    const ex = (await compileToWasm(
      `export function test(): any { var d: any; if (true) { d = new Date(0); } else { d = /x/; } return typeof d; }`,
    )) as { test: () => unknown };
    expect(ex.test()).toBe("object");
  });
});
