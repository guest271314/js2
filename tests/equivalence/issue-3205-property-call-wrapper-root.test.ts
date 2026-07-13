import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

// #3205 — property-call / element-access callable dispatch must be independent
// of funcref-wrapper creation ORDER. A closure whose ACTUAL signature differs
// from the field's DECLARED type (covariant return, or an activated async
// closure whose result is rewritten to externref/Promise) is allocated under a
// different `sub final` sibling wrapper struct; casting to the declared wrapper
// (and its single funcref) nulls out and `call_ref` traps ("dereferencing a
// null pointer"). All four cases trap on pre-#3205 main; the root-wrapper cast +
// funcref-type dispatch fixes them.
describe("#3205 property/element callable wrapper-root dispatch", () => {
  it("covariant number return stored in a () => void class field", async () => {
    const code = `
      class Runner {
        fn: () => void;
        constructor(f: () => void) { this.fn = f; }
        run(): void { this.fn(); }
      }
      let counter = 0;
      function bumpNum(): number { counter = counter + 1; return 7; }
      export function test(): number {
        const r = new Runner(bumpNum);
        r.run();
        r.run();
        return counter;
      }
    `;
    await assertEquivalent(code, [{ fn: "test", args: [] }]);
  });

  it("covariant string return stored in a () => void class field", async () => {
    const code = `
      class Runner {
        fn: () => void;
        constructor(f: () => void) { this.fn = f; }
        run(): void { this.fn(); }
      }
      let counter = 0;
      function bumpStr(): string { counter = counter + 1; return "x"; }
      export function test(): number {
        const r = new Runner(bumpStr);
        r.run();
        r.run();
        return counter;
      }
    `;
    await assertEquivalent(code, [{ fn: "test", args: [] }]);
  });

  it("async arrow closure stored in a () => void class field", async () => {
    const code = `
      class Runner {
        fn: () => void;
        constructor(f: () => void) { this.fn = f; }
        run(): void { this.fn(); }
      }
      let counter = 0;
      export function test(): number {
        const r = new Runner(async () => { counter = counter + 1; });
        r.run();
        r.run();
        return counter;
      }
    `;
    await assertEquivalent(code, [{ fn: "test", args: [] }]);
  });

  it("covariant returns through an element-access call arr[i]()", async () => {
    const code = `
      let counter = 0;
      function a(): number { counter = counter + 1; return 1; }
      function b(): string { counter = counter + 10; return "x"; }
      export function test(): number {
        const arr: Array<() => void> = [a, b];
        arr[0]();
        arr[1]();
        return counter;
      }
    `;
    await assertEquivalent(code, [{ fn: "test", args: [] }]);
  });

  it("matching signature stays correct (single-candidate byte-identical path)", async () => {
    const code = `
      class Runner {
        fn: () => number;
        constructor(f: () => number) { this.fn = f; }
        run(): number { return this.fn(); }
      }
      let counter = 0;
      function bumpNum(): number { counter = counter + 1; return counter; }
      export function test(): number {
        const r = new Runner(bumpNum);
        r.run();
        return r.run();
      }
    `;
    await assertEquivalent(code, [{ fn: "test", args: [] }]);
  });
});
