// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2726 group (a) — sloppy-mode `delete <unresolvable identifier>` → true.
//
// §13.5.1.2 (Runtime Semantics: Evaluation of `delete UnaryExpression`) step 4:
// if the reference produced by the operand IsUnresolvableReference (the name
// resolves to NO binding anywhere), `delete` evaluates to `true` in sloppy mode.
// (Strict mode makes `delete <bare identifier>` an early SyntaxError, so this
// path is only ever reached in sloppy code — `isStrictMode` returns false for a
// plain non-`"use strict"` source, matching test262 `noStrict` scripts.)
//
// Previously the compiler returned `false` for EVERY bare-identifier delete
// (the "variables are not deletable" path), so the three test262 targets
// (S11.4.1_A2.2_T1, S11.4.1_A3.3_T6, 11.4.1-3-1) failed.
//
// Root-cause / oracle: an unresolvable identifier yields NO symbol from the TS
// checker (`getSymbolAtLocation === undefined`). The non-configurable intrinsic
// globals that MUST stay `false` (`undefined`, `arguments`, `globalThis`,
// `NaN`, `Infinity`) DO return a symbol (or are name-excluded), so they correctly
// remain `false`. Symbol-presence — not the weaker `!valueDeclaration` heuristic
// — is what keeps those intrinsics out of `true`. (#2726 (b) later refined this:
// the OTHER lib-declared globals — `JSON`/`Object`/`Math`/… — are CONFIGURABLE
// global properties, so `delete` of them returns `true`; see the dedicated
// group-(b) test file.)

async function run(source: string): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setExports?: (e: Record<string, (...a: unknown[]) => unknown>) => void }).setExports?.(
    instance.exports as Record<string, (...a: unknown[]) => unknown>,
  );
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>).test();
}

async function runStandalone(source: string): Promise<unknown> {
  const result = await compile(source, { target: "standalone" });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>).test();
}

describe("#2726 (a) sloppy delete of unresolvable identifier", () => {
  // §13.5.1.2 step 4: a bare identifier that resolves to no binding → true.
  const unresolvableSrc = `
    export function test(): number {
      if ((delete unresolvableXyz) !== true) return 10;
      return 1;
    }`;

  it("delete of a never-declared identifier returns true (host)", async () => {
    expect(await run(unresolvableSrc)).toBe(1);
  });

  it("delete of a never-declared identifier returns true (standalone)", async () => {
    expect(await runStandalone(unresolvableSrc)).toBe(1);
  });

  // Mirrors S11.4.1_A3.3_T6: a typo'd identifier (a similar name IS declared)
  // is still unresolvable → true.
  it("delete of a typo'd identifier (similar name declared) returns true", async () => {
    const src = `
      export function test(): number {
        var MyObjectVar = 1;
        if ((delete MyObjectNotVar) !== true) return 10;
        return 1;
      }`;
    expect(await run(src)).toBe(1);
  });

  // Hazard guard — these MUST stay false (non-configurable / real bindings):
  // a naive "unknown ⇒ true" flip would wrongly delete them.
  it("delete NaN / Infinity / undefined / globalThis stay false (non-configurable globals)", async () => {
    const src = `
      export function test(): number {
        if ((delete NaN) !== false) return 11;
        if ((delete Infinity) !== false) return 12;
        if ((delete undefined) !== false) return 13;
        if ((delete globalThis) !== false) return 14;
        return 1;
      }`;
    expect(await run(src)).toBe(1);
  });

  it("delete of a declared variable stays false (environment binding)", async () => {
    const src = `
      export function test(): number {
        var declared = 5;
        if ((delete declared) !== false) return 11;
        return 1;
      }`;
    expect(await run(src)).toBe(1);
  });

  // (#2726 (b) refinement) JSON / Object are CONFIGURABLE global properties
  // (ECMA-262 §19) ⇒ `delete` returns true (test262 11.4.1-4.a-8). This
  // corrects the group-(a) conservative placeholder that kept them false;
  // only NaN / Infinity / undefined are non-configurable (guarded above).
  it("delete of a configurable built-in global (JSON / Object) returns true", async () => {
    const src = `
      export function test(): number {
        if ((delete JSON) !== true) return 11;
        if ((delete Object) !== true) return 12;
        return 1;
      }`;
    expect(await run(src)).toBe(1);
  });
});
