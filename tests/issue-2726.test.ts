// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2726 — delete residual (non-throw): hasOwnProperty-after-delete for a
// `Object.defineProperty`'d property on a statically `{}`-typed struct, plus the
// strict-mode TypeError on deleting a non-configurable accessor.
//
// Root cause: `var o = {}` infers an empty struct type, so `o.hasOwnProperty(k)`
// constant-folds against the (defineProperty-widened) static struct shape and
// ignores a subsequent configurable `delete`'s `_wasmStructDeletedKeys`
// tombstone. The dominant ES5 shape `var d = {...}; Object.defineProperty(o,k,d)`
// routes through the runtime descriptor applier, which `definedPropertyFlags`
// (inline-literal only) never sees — so the fold's runtime-routing guard never
// fired. The inline-accessor fast path additionally never mirrored
// `configurable:false` to the runtime, so `delete obj.accessor` wrongly succeeded.

async function run(source: string): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, (...a: unknown[]) => unknown>);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>).test();
}

// Standalone (pure-Wasm, no JS host) compile + run. The standalone
// `__hasOwnProperty` does NOT report a `defineProperty`-added struct-shape
// property as own, so the host-mode runtime-routing of `hasOwnProperty`
// (groups (c)) must be gated to host mode (#2726 standalone-floor park on PR
// #2177). This runner exercises that gate.
async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, { target: "standalone" });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>).test();
}

describe("#2726 delete residual", () => {
  // (c) 11.4.1-4.a-1: configurable data property, variable descriptor.
  it("hasOwnProperty is false after deleting a configurable data property (variable descriptor)", async () => {
    const src = `
      export function test(): number {
        var o = {};
        var desc = { value: 1, configurable: true };
        Object.defineProperty(o, 'foo', desc);
        var d = delete o.foo;
        if (d !== true) return 10;
        if (o.hasOwnProperty('foo') !== false) return 11;
        return 1;
      }`;
    expect(await run(src)).toBe(1);
  });

  // (c) 11.4.1-4.a-2: configurable accessor property, variable descriptor.
  it("hasOwnProperty is false after deleting a configurable accessor property (variable descriptor)", async () => {
    const src = `
      export function test(): number {
        var o = {};
        var getter = function() { return 1; };
        var desc = { get: getter, configurable: true };
        Object.defineProperty(o, 'foo', desc);
        var d = delete o.foo;
        if (d !== true) return 10;
        if (o.hasOwnProperty('foo') !== false) return 11;
        return 1;
      }`;
    expect(await run(src)).toBe(1);
  });

  // (c) 11.4.1-4-a-4-s: configurable accessor, inline descriptor.
  it("hasOwnProperty is false after deleting a configurable inline-accessor property", async () => {
    const src = `
      export function test(): number {
        var obj = {};
        Object.defineProperty(obj, 'prop', {
          get: function() { return 'abc'; },
          configurable: true,
        });
        delete obj.prop;
        if (obj.hasOwnProperty('prop') !== false) return 11;
        return 1;
      }`;
    expect(await run(src)).toBe(1);
  });

  // defineProperty WITHOUT a following delete must still report the property as own.
  it("hasOwnProperty stays true for a defineProperty'd property that is not deleted", async () => {
    const src = `
      export function test(): number {
        var o = {};
        var d = { value: 1, configurable: true };
        Object.defineProperty(o, 'a', d);
        if (o.hasOwnProperty('a') !== true) return 10;
        return 1;
      }`;
    expect(await run(src)).toBe(1);
  });

  // (d) 11.4.1-4-a-2-s: strict-mode delete of a non-configurable accessor throws
  // TypeError, and the property survives.
  it("strict delete of a non-configurable accessor throws TypeError and leaves the property", async () => {
    const src = `
      export function test(): number {
        "use strict";
        var obj = {};
        Object.defineProperty(obj, 'prop', {
          get: function() { return 'abc'; },
          configurable: false,
        });
        var threw = 0;
        try {
          delete obj.prop;
        } catch (e) {
          threw = 1;
        }
        if (threw !== 1) return 10;
        if (obj.prop !== 'abc') return 11;
        return 1;
      }`;
    expect(await run(src)).toBe(1);
  });

  // Sloppy-mode delete of a non-configurable accessor returns false (no throw),
  // and the property survives.
  it("sloppy delete of a non-configurable accessor returns false and leaves the property", async () => {
    const src = `
      export function test(): number {
        var obj = {};
        Object.defineProperty(obj, 'prop', {
          get: function() { return 'abc'; },
          configurable: false,
        });
        var d = delete obj.prop;
        if (d !== false) return 10;
        if (obj.prop !== 'abc') return 11;
        return 1;
      }`;
    expect(await run(src)).toBe(1);
  });

  // (#2177 standalone-floor park) In STANDALONE mode the broad host-routing of
  // `hasOwnProperty`/`propertyIsEnumerable` must NOT fire: the wasm-native
  // `__hasOwnProperty` returns false for a defineProperty-added struct-shape
  // property, which regressed ~12 built-ins/Object/{defineProperty,prototype/
  // hasOwnProperty} tests. Gating the new signals to host mode keeps the
  // (correct, no-delete) const-fold in standalone.
  it("standalone: hasOwnProperty is true after defineProperty of an inline accessor (no delete)", async () => {
    const src = `
      export function test(): number {
        var o = {};
        Object.defineProperty(o, "foo", { get: function() { return 42; } });
        return o.hasOwnProperty("foo") ? 1 : 0;
      }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("standalone: hasOwnProperty is true after defineProperty with a variable descriptor (no delete)", async () => {
    const src = `
      export function test(): number {
        var o = {};
        var d = { value: 1001, enumerable: true, configurable: true };
        Object.defineProperty(o, "property", d);
        return o.hasOwnProperty("property") ? 1 : 0;
      }`;
    expect(await runStandalone(src)).toBe(1);
  });
});
