// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2726 group (b), partial — sloppy-mode `delete <configurable built-in global>`
// returns `true`.
//
// §13.5.1.2 (Runtime Semantics: Evaluation of `delete UnaryExpression`) step 5:
// a `delete IdentifierReference` that resolves to a CONFIGURABLE property of the
// global object evaluates to `true` in sloppy mode (the property is deletable).
// Per ECMA-262 §19 every built-in global property (`JSON`/`Object`/`Math`/
// `parseInt`/…) is `{[[Configurable]]: true}` EXCEPT the three intrinsics
// `NaN`/`Infinity`/`undefined`.
//
// Previously the bare-identifier delete arm returned `false` for every resolvable
// name, so `delete JSON` wrongly returned `false` (test262 11.4.1-4.a-8 failed).
//
// Oracle: a built-in global's TS-checker symbol has declarations that are ALL in
// ambient `.d.ts` lib files, whereas a user var/function is declared in the
// program's own source (non-configurable global binding ⇒ `false`). Combined
// with the `NaN`/`Infinity`/`undefined` name-exclusion, this cleanly separates
// configurable built-ins (→ true) from non-configurable intrinsics and user
// bindings (→ false). This is a front-end constant flip (`i32.const 1`), so both
// the host and standalone lanes agree with no new host import.

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

describe("#2726 (b) sloppy delete of a configurable built-in global", () => {
  // Mirrors test262 11.4.1-4.a-8: `delete JSON === true`.
  const deleteJsonSrc = `
    export function test(): number {
      if ((delete JSON) !== true) return 10;
      return 1;
    }`;

  it("delete JSON returns true (host)", async () => {
    expect(await run(deleteJsonSrc)).toBe(1);
  });

  it("delete JSON returns true (standalone)", async () => {
    expect(await runStandalone(deleteJsonSrc)).toBe(1);
  });

  it("delete of other configurable built-ins returns true", async () => {
    const src = `
      export function test(): number {
        if ((delete Object) !== true) return 11;
        if ((delete Math) !== true) return 12;
        if ((delete parseInt) !== true) return 13;
        if ((delete Array) !== true) return 14;
        return 1;
      }`;
    expect(await run(src)).toBe(1);
  });

  // Guard: the three non-configurable intrinsics MUST stay false — the fix must
  // not over-flip them (they are name-excluded / have no ambient declarations).
  it("delete of NaN / Infinity / undefined stays false", async () => {
    const src = `
      export function test(): number {
        if ((delete NaN) !== false) return 11;
        if ((delete Infinity) !== false) return 12;
        if ((delete undefined) !== false) return 13;
        return 1;
      }`;
    expect(await run(src)).toBe(1);
  });

  // Guard: a user-declared var / function is a non-configurable global binding —
  // its symbol has a non-ambient declaration, so `delete` stays false.
  it("delete of a user-declared var / function stays false", async () => {
    const src = `
      export function test(): number {
        var userVar = 1;
        function userFunc() {}
        if ((delete userVar) !== false) return 11;
        if ((delete userFunc) !== false) return 12;
        return 1;
      }`;
    expect(await run(src)).toBe(1);
  });
});
