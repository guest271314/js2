// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2018 — a `return` statement inside a base-class constructor must not trap.
//
// Per §10.2.1.3 [[Construct]] step 13 a constructor `return` never yields the
// raw operand: a returned Object overrides `this`, while a returned primitive
// (or bare `return;` / `return undefined`) is discarded and the constructor
// result is `this`. Before the fix, `compileReturnStatement` fell through to
// the generic value-return path, which pushed `ref.null <struct>` for a bare /
// primitive return and `ref.cast`-coerced an object operand to the struct
// return type — both producing a null/illegal struct ref that trapped
// "dereferencing a null pointer" at the `new` site.
//
// Architectural limit: the constructor's Wasm return type is `(ref $Struct)`
// and every `new` site is typed to it, so a *foreign* plain-object override
// (`return { ... } as any`) is not representable as the struct result. That
// case resolves to `this` (non-trapping) rather than the override object; a
// same-class instance override (`return this` / `return new Same()`) IS
// representable and works. Derived constructors are out of scope here (their
// post-`super()` `this` aliasing is a separate path).

import { describe, expect, it } from "vitest";

import { compileAndInstantiate } from "../src/runtime.js";

async function run(src: string): Promise<number> {
  const exports = (await compileAndInstantiate(src)) as { test(): number };
  return exports.test();
}

describe("#2018 base-class constructor return does not trap", () => {
  it("bare `return;` guard clause yields `this`, not a null deref", async () => {
    expect(
      await run(`
        class A { x = 1; constructor() { if (this.x > 0) return; this.x = 2; } }
        export function test(): number { return new A().x; }`),
    ).toBe(1);
  });

  it("a `return;` taken later still applies the preceding mutations", async () => {
    expect(
      await run(`
        class A { x = 1; y = 2; constructor(skip: boolean) { if (skip) { return; } this.x = 10; this.y = 20; } }
        export function test(): number { const a = new A(true); return a.x + a.y; }`),
    ).toBe(3);
  });

  it("`return <primitive> as any` is ignored, ctor result is `this`", async () => {
    expect(
      await run(`
        class A { x = 5; constructor() { return 42 as any; } }
        export function test(): number { return new A().x; }`),
    ).toBe(5);
  });

  it("`return null as any` / `return undefined as any` / `return string as any` all yield `this`", async () => {
    expect(
      await run(`
        class A { x = 6; constructor() { return null as any; } }
        export function test(): number { return new A().x; }`),
    ).toBe(6);
    expect(
      await run(`
        class A { x = 7; constructor() { return undefined as any; } }
        export function test(): number { return new A().x; }`),
    ).toBe(7);
    expect(
      await run(`
        class A { x = 8; constructor() { return 'hi' as any; } }
        export function test(): number { return new A().x; }`),
    ).toBe(8);
  });

  it("`return this` after mutation yields the mutated instance", async () => {
    expect(
      await run(`
        class A { x = 3; constructor() { this.x = 9; return this; } }
        export function test(): number { return new A().x; }`),
    ).toBe(9);
  });

  it("`return new SameClass()` overrides `this` with the same-struct instance", async () => {
    expect(
      await run(`
        class A { x = 0; constructor(v: number) { this.x = v; if (v < 0) return new A(0); } }
        export function test(): number { return new A(-1).x; }`),
    ).toBe(0);
  });

  it("a constructor with no `return` is unchanged", async () => {
    expect(
      await run(`
        class A { x = 7; constructor() { this.x = 8; } }
        export function test(): number { return new A().x; }`),
    ).toBe(8);
  });

  it("a foreign plain-object `return ... as any` does not trap (resolves to `this`, see architectural limit)", async () => {
    // Spec-ideal would be 99 (the override object). Until the constructor /
    // `new` return type becomes externref-based this is the non-trapping
    // fallback; the key guarantee asserted here is "no null-deref trap".
    expect(
      await run(`
        class A { x = 1; constructor() { return { x: 99 } as any; } }
        export function test(): number { return (new A() as any).x; }`),
    ).toBe(1);
  });
});
