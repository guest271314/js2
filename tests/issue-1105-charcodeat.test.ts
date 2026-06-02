// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1105 — standalone/native String.prototype.charCodeAt.
//
// Spec reference: ECMA-262 section 22.1.3.3 String.prototype.charCodeAt(pos)
// converts pos with ToIntegerOrInfinity, then returns NaN when the resulting
// position is outside the string's UTF-16 code-unit range.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

const ENV_STUB = {
  console_log_number: () => {},
  console_log_string: () => {},
  console_log_bool: () => {},
};

async function compileNative(source: string): Promise<Record<string, unknown>> {
  const r = await compile(source, {
    nativeStrings: true,
    testRuntime: true,
    fileName: "issue-1105-charcodeat.ts",
  });
  if (!r.success) {
    const errors = Array.isArray(r.errors) ? r.errors.map((err) => err.message).join("; ") : "no errors array";
    throw new Error(`compile failed: ${errors}`);
  }
  expect(r.imports.some((imp) => imp.module === "env" && imp.name === "string_charCodeAt")).toBe(false);
  const built = buildImports(r.imports, ENV_STUB, r.stringPool);
  const { instance } = await instantiateWasm(r.binary, built.env, built.string_constants);
  const exports = instance.exports as Record<string, unknown>;
  built.setExports?.(exports as Record<string, Function>);
  return exports;
}

describe("#1105 nativeStrings charCodeAt", () => {
  it("reads UTF-16 code units from a native string parameter without a host string_charCodeAt import", async () => {
    const exports = await compileNative(`
      export function codeAt(s: string, i: number): number {
        return s.charCodeAt(i);
      }
    `);
    const toNative = exports.__test_str_from_externref as (s: string) => unknown;
    const codeAt = exports.codeAt as (s: unknown, i: number) => number;

    expect(codeAt(toNative("AZ"), 0)).toBe(65);
    expect(codeAt(toNative("AZ"), 1)).toBe(90);
  });

  it("returns NaN for positions outside the native string code-unit range", async () => {
    const exports = await compileNative(`
      export function beforeStart(): number {
        return "AZ".charCodeAt(-1);
      }

      export function atLength(): number {
        return "AZ".charCodeAt(2);
      }
    `);
    const beforeStart = exports.beforeStart as () => number;
    const atLength = exports.atLength as () => number;

    expect(Number.isNaN(beforeStart())).toBe(true);
    expect(Number.isNaN(atLength())).toBe(true);
  });

  it("applies ToIntegerOrInfinity before bounds checking", async () => {
    const exports = await compileNative(`
      export function omitted(): number {
        return "AZ".charCodeAt();
      }

      export function nanPosition(): number {
        return "AZ".charCodeAt(0 / 0);
      }

      export function negativeFraction(): number {
        return "AZ".charCodeAt(-0.5);
      }

      export function positiveFraction(): number {
        return "AZ".charCodeAt(1.9);
      }
    `);

    expect((exports.omitted as () => number)()).toBe(65);
    expect((exports.nanPosition as () => number)()).toBe(65);
    expect((exports.negativeFraction as () => number)()).toBe(65);
    expect((exports.positiveFraction as () => number)()).toBe(90);
  });

  it("does not fold out-of-range charCodeAt into an i32-pure arithmetic leaf", async () => {
    const exports = await compileNative(`
      export function inRange(): number {
        return (1 + "AZ".charCodeAt(1)) | 0;
      }

      export function outOfRange(): number {
        return (1 + "AZ".charCodeAt(9)) | 0;
      }
    `);

    expect((exports.inRange as () => number)()).toBe(91);
    expect((exports.outOfRange as () => number)()).toBe(0);
  });
});
