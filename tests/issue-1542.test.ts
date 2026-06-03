// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

describe("#1542 control-flow nested class method destructuring defaults", () => {
  it("uses a sibling generator declared after a class in a try block", async () => {
    const ex = await compileToWasm(`
      let first: number = 0;
      let calls: number = 0;

      export function test(): number {
        try {
          class C {
            method([,] = g()): void { calls += 1; }
          }
          function* g(): any {
            first += 1;
            yield;
          }
          new C().method();
        } catch (_e: any) {
          return -1;
        }
        return first * 100 + calls;
      }
    `);

    expect((ex.test as () => number)()).toBe(101);
  });

  it("uses a sibling generator declared before a class in a try block", async () => {
    const ex = await compileToWasm(`
      let first: number = 0;
      let calls: number = 0;

      export function test(): number {
        try {
          function* g(): any {
            first += 1;
            yield;
          }
          class C {
            method([,] = g()): void { calls += 1; }
          }
          new C().method();
        } catch (_e: any) {
          return -1;
        }
        return first * 100 + calls;
      }
    `);

    expect((ex.test as () => number)()).toBe(101);
  });

  it("fires an inner array binding default from the test262 class shape", async () => {
    const ex = await compileToWasm(`
      let first: number = 0;
      let calls: number = 0;

      export function test(): number {
        try {
          class C {
            method([[,] = g()] = []): void { calls += 1; }
          }
          function* g(): any {
            first += 1;
            yield;
          }
          new C().method();
        } catch (_e: any) {
          return -1;
        }
        return first * 100 + calls;
      }
    `);

    expect((ex.test as () => number)()).toBe(101);
  });

  it("uses sibling generator defaults for private and static methods", async () => {
    const ex = await compileToWasm(`
      let first: number = 0;
      let calls: number = 0;

      export function testPrivate(): number {
        try {
          class C {
            #m([,] = g()): void { calls += 1; }
            run(): void { this.#m(); }
          }
          function* g(): any {
            first += 1;
            yield;
          }
          new C().run();
        } catch (_e: any) {
          return -1;
        }
        return first * 100 + calls;
      }

      export function testStatic(): number {
        try {
          class C {
            static m([,] = h()): void { calls += 1; }
          }
          function* h(): any {
            first += 1;
            yield;
          }
          C.m();
        } catch (_e: any) {
          return -1;
        }
        return first * 100 + calls;
      }
    `);

    expect((ex.testPrivate as () => number)()).toBe(101);
    expect((ex.testStatic as () => number)()).toBe(202);
  });

  it("pre-registers sibling generators for anonymous class expressions", async () => {
    const ex = await compileToWasm(`
      let first: number = 0;
      let calls: number = 0;

      export function test(): number {
        try {
          function* g(): any {
            first += 1;
            yield;
          }
          const c = new (class {
            method([,] = g()): void { calls += 1; }
          })();
          c.method();
        } catch (_e: any) {
          return -1;
        }
        return first * 100 + calls;
      }
    `);

    expect((ex.test as () => number)()).toBe(101);
  });

  it("keeps control-flow nested class method bodies executable", async () => {
    const ex = await compileToWasm(`
      export function test(): number {
        let total: number = 0;
        if (true) {
          class A { m(): number { return 1; } }
          total += new A().m();
        }
        try {
          class B { m(): number { return 2; } }
          total += new B().m();
        } catch (_e: any) {
          return -1;
        }
        for (let i: number = 0; i < 2; i += 1) {
          class D { m(): number { return 3; } }
          total += new D().m();
        }
        switch (1) {
          case 1: {
            class E { m(): number { return 4; } }
            total += new E().m();
            break;
          }
        }
        return total;
      }
    `);

    expect((ex.test as () => number)()).toBe(13);
  });
});
