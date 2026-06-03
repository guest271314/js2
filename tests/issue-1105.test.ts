// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1105 — Wasm-native String.prototype methods in nativeStrings/standalone mode.
//
// Spec references:
// - ECMA-262 §22.1.3.9 String.prototype.indexOf: StringIndexOf + -1 for not-found.
// - ECMA-262 §22.1.3.22 String.prototype.split: string separators produce an Array of substrings.
// - ECMA-262 §22.1.3.32 String.prototype.trim: returns TrimString(string, start+end).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

function envStringMethodImports(imports: Array<{ module: string; name: string }>): string[] {
  return imports.filter((imp) => imp.module === "env" && imp.name.startsWith("string_")).map((imp) => imp.name);
}

async function compileNativeRuntime(
  source: string,
  options: { fast?: boolean } = {},
): Promise<Record<string, unknown>> {
  const result = await compile(source, {
    fast: options.fast ?? true,
    nativeStrings: true,
    testRuntime: true,
    fileName: "issue-1105.ts",
  });
  expect(result.success, result.errors.map((err) => err.message).join("\n")).toBe(true);
  expect(envStringMethodImports(result.imports)).toEqual([]);

  const imports = buildImports(result.imports, ENV_STUB, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, unknown>;
}

describe("#1105 native String method helpers", () => {
  it("does not request JS-host string method imports for standalone Tier 1 methods", async () => {
    const result = await compile(
      `
      export function indexOfAcceptance(): number {
        return "hello".indexOf("ll");
      }

      export function splitAcceptance(): number {
        const parts = "hello world".split(" ");
        return parts.length * 100 + parts[0].length * 10 + parts[1].length;
      }

      export function trimAcceptance(): number {
        return "  hello  ".trim().length;
      }

      export function codePointAcceptance(): number {
        return "😀".codePointAt(0)!;
      }
      `,
      { target: "standalone", fileName: "issue-1105-standalone.ts" },
    );

    expect(result.success, result.errors.map((err) => err.message).join("\n")).toBe(true);
    expect(envStringMethodImports(result.imports)).toEqual([]);
    expect(result.wat).not.toContain("wasm:js-string");
  });

  it("runs indexOf, split, and trim acceptance cases through native Wasm helpers", async () => {
    const exports = await compileNativeRuntime(`
      export function indexOfAcceptance(): number {
        return "hello".indexOf("ll");
      }

      export function splitAcceptance(): number {
        const parts = "hello world".split(" ");
        return parts.length * 100 + parts[0].length * 10 + parts[1].length;
      }

      export function trimAcceptance(): number {
        return "  hello  ".trim().length;
      }

      export function codePointAcceptance(): number {
        return "😀".codePointAt(0)!;
      }

    `);

    expect((exports.indexOfAcceptance as () => number)()).toBe(2);
    expect((exports.splitAcceptance as () => number)()).toBe(255);
    expect((exports.trimAcceptance as () => number)()).toBe(5);
    expect((exports.codePointAcceptance as () => number)()).toBe(0x1f600);
  });

  it("returns the native numeric sentinel for out-of-range codePointAt before fast i32 coercion", async () => {
    const exports = await compileNativeRuntime(
      `
      export function codePointOutOfRange(): number {
        return "abc".codePointAt(9)!;
      }
      `,
      { fast: false },
    );

    expect(Number.isNaN((exports.codePointOutOfRange as () => number)())).toBe(true);
  });

  it("keeps native string method numeric arguments stack-valid in fast mode", async () => {
    const exports = await compileNativeRuntime(`
      export function indexFrom(): number {
        return "abcabc".indexOf("abc", 1);
      }

      export function startsAt(): number {
        return "hello world".startsWith("world", 6) ? 1 : 0;
      }

      export function includesBranch(): number {
        return "hello world".includes("world") ? 1 : 0;
      }
    `);

    expect((exports.indexFrom as () => number)()).toBe(3);
    expect((exports.startsAt as () => number)()).toBe(1);
    expect((exports.includesBranch as () => number)()).toBe(1);
  });

  it("validates repeat without emitting invalid native string globals", async () => {
    const exports = await compileNativeRuntime(`
      export function repeatLen(): number {
        return "ab".repeat(3).length;
      }
    `);

    expect((exports.repeatLen as () => number)()).toBe(6);
  });

  it("concatenates via the native helper without requesting string_concat", async () => {
    // ECMA-262 §22.1.3.4 String.prototype.concat: ToString each argument, then
    // append left-to-right. Standalone mode must lower this to the native
    // __str_concat chain and never reach the JS-host `string_concat` import.
    const result = await compile(
      `
      export function concatTwo(): number {
        return "ab".concat("cd").length;
      }
      `,
      { target: "standalone", fileName: "issue-1105-concat.ts" },
    );
    expect(result.success, result.errors.map((err) => err.message).join("\n")).toBe(true);
    expect(envStringMethodImports(result.imports)).toEqual([]);
    expect(result.wat).not.toContain("wasm:js-string");

    const exports = await compileNativeRuntime(`
      export function concatTwo(): number {
        return "ab".concat("cd").length;
      }

      export function concatVariadic(): number {
        return "a".concat("b", "c", "d").length;
      }

      export function concatNoArgs(): number {
        return "abc".concat().length;
      }

      export function concatCharAt(): number {
        const a = "xy";
        const b = "z";
        return a.concat(b).charCodeAt(2);
      }
    `);

    expect((exports.concatTwo as () => number)()).toBe(4);
    expect((exports.concatVariadic as () => number)()).toBe(4);
    expect((exports.concatNoArgs as () => number)()).toBe(3);
    expect((exports.concatCharAt as () => number)()).toBe(122);
  });
});
