// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3278 — behaviour-preserving intra-function decomposition of the ~1.3k-LOC
// god-function compileArrowAsClosure in src/codegen/closures.ts. The function is
// split into named phase helpers:
//   - planClosureCaptures      (phase 1: capture analysis)
//   - mintClosureStructTypes   (phase 2: capture-struct type minting)
//   - emitClosureParamDestructuring / emitClosureConstruction /
//     registerClosureBindingInfo (phases 4/6: emission + registration)
//
// This is a smoke test (the #2093 issue→probe coverage gate): it compiles and
// runs closures/arrows that drive each decomposed phase, confirming the
// extraction preserved observable behaviour. The emitted-Wasm byte-identity
// proof (scripts/prove-emit-identity.mjs) is the stronger guarantee; these
// assertions guard the end-to-end runtime contract.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<Record<string, Function>> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return instance.exports as unknown as Record<string, Function>;
}

describe("#3278 compileArrowAsClosure phase decomposition (behaviour preserved)", () => {
  it("no-capture arrow, concise body (wrapper-struct reuse path)", async () => {
    const exports = await run(`
      export function test(): number {
        const add = (a: number, b: number) => a + b;
        return add(2, 3);
      }
    `);
    expect(exports.test()).toBe(5);
  });

  it("immutable outer capture (planClosureCaptures: non-mutable)", async () => {
    const exports = await run(`
      export function test(): number {
        const base = 10;
        const addBase = (x: number) => x + base;
        return addBase(5);
      }
    `);
    expect(exports.test()).toBe(15);
  });

  it("mutable capture — closure write visible to outer scope (ref cell)", async () => {
    const exports = await run(`
      export function test(): number {
        let counter = 0;
        const inc = () => { counter = counter + 1; };
        inc();
        inc();
        inc();
        return counter;
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("outer write visible to closure (writtenInOuter boxing)", async () => {
    const exports = await run(`
      export function test(): number {
        let v = 1;
        const read = () => v;
        v = 42;
        return read();
      }
    `);
    expect(exports.test()).toBe(42);
  });

  it("nested closures with transitive captures", async () => {
    const exports = await run(`
      export function test(): number {
        let acc = 0;
        const outer = () => {
          const inner = () => {
            acc = acc + 5;
          };
          inner();
          inner();
        };
        outer();
        return acc;
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("named function expression recursion (self via __self)", async () => {
    const exports = await run(`
      export function test(): number {
        const fact = function f(n: number): number {
          return n <= 1 ? 1 : n * f(n - 1);
        };
        return fact(5);
      }
    `);
    expect(exports.test()).toBe(120);
  });

  it("self-recursive const arrow binding (#2118 __self routing)", async () => {
    const exports = await run(`
      export function test(): number {
        const fib = (n: number): number => (n < 2 ? n : fib(n - 1) + fib(n - 2));
        return fib(10);
      }
    `);
    expect(exports.test()).toBe(55);
  });

  it("function-expression array-destructuring param (emitClosureParamDestructuring)", async () => {
    const exports = await run(`
      export function test(): number {
        const sum3 = function ([a, b, c]: number[]): number {
          return a + b + c;
        };
        return sum3([4, 5, 6]);
      }
    `);
    expect(exports.test()).toBe(15);
  });

  it("arrow with default parameter", async () => {
    const exports = await run(`
      export function test(): number {
        const f = (x: number, y: number = 7) => x + y;
        return f(3);
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("generator function expression with a param (eager buffer path)", async () => {
    // A declared param makes the generator lazy-INeligible (#3032), so it takes
    // the eager-buffer path — no host `setExports` wiring needed. Still drives
    // the closure struct/capture phases for the function-expression.
    const exports = await run(`
      export function test(): number {
        const gen = function* (start: number) {
          yield start;
          yield start + 1;
          yield start + 2;
        };
        const g = gen(1);
        let total = 0;
        for (const v of g) {
          total = total + v;
        }
        return total;
      }
    `);
    expect(exports.test()).toBe(6);
  });
});
