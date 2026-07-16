// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3271 — behaviour-preserving god-file breakdown of src/codegen/generators-native.ts:
//   - the native-generator CONSUMER / call-site subsystem moved to
//     generators-native-consumer.ts (.next()/.return()/.throw(), result-struct
//     reads, for-of / spread / toVec draining);
//   - the pure AST-scan predicate primitives moved to generators-native-ast-scan.ts;
//   - DRY dedups (loadCastState, readResultField, isFunctionLikeScope).
//
// This is a smoke test (the #2093 issue→probe coverage gate): it compiles and
// runs programs that drive a Wasm-native generator through each relocated
// consumer path, confirming the extraction preserved observable behaviour. The
// emitted-Wasm byte-identity proof (scripts/prove-emit-identity.mjs) is the
// stronger guarantee; these assertions guard the end-to-end runtime contract.
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

describe("#3271 native-generator consumer/ast-scan extraction (behaviour preserved)", () => {
  it("drives .next() and reads {value,done} inside wasm (method-call + result-property paths)", async () => {
    const exports = await run(`
      function* nums(): Generator<number> {
        yield 10;
        yield 20;
        yield 30;
      }
      export function sumFirstTwo(): number {
        const g = nums();
        const a = g.next();
        const b = g.next();
        if (a.done || b.done) return -1;
        return a.value + b.value;
      }
      export function countAll(): number {
        const g = nums();
        let count = 0;
        let r = g.next();
        while (!r.done) {
          count += 1;
          r = g.next();
        }
        return count;
      }
    `);
    expect((exports.sumFirstTwo as Function)()).toBe(30);
    expect((exports.countAll as Function)()).toBe(3);
  }, 30000);

  it("drains a native generator in for-of (tryCompileNativeGeneratorForOf path)", async () => {
    const exports = await run(`
      function* range(start: number, end: number): Generator<number> {
        for (let i = start; i <= end; i++) {
          yield i;
        }
      }
      export function total(): number {
        let s = 0;
        for (const x of range(1, 5)) {
          s += x;
        }
        return s;
      }
    `);
    expect((exports.total as Function)()).toBe(15);
  }, 30000);

  it("materializes a native generator via spread (emitNativeGeneratorToVec path)", async () => {
    const exports = await run(`
      function* items(): Generator<number> {
        yield 4;
        yield 5;
        yield 6;
      }
      export function collectLen(): number {
        const arr = [...items()];
        return arr.length;
      }
      export function collectSum(): number {
        const arr = [...items()];
        let s = 0;
        for (let i = 0; i < arr.length; i++) s += arr[i];
        return s;
      }
    `);
    expect((exports.collectLen as Function)()).toBe(3);
    expect((exports.collectSum as Function)()).toBe(15);
  }, 30000);

  it("honours .return() early-completion (dispatch return-arm path)", async () => {
    const exports = await run(`
      function* g(): Generator<number> {
        yield 1;
        yield 2;
        yield 3;
      }
      export function early(): number {
        const it = g();
        it.next();
        const r = it.return(99);
        return r.done ? r.value : -1;
      }
    `);
    expect((exports.early as Function)()).toBe(99);
  }, 30000);
});
