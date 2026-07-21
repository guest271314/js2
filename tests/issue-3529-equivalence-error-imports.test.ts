// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "./equivalence/helpers.js";

const ERROR_CASES = [
  ["Error", `new Error("boom")`],
  ["TypeError", `new TypeError("boom")`],
  ["RangeError", `new RangeError("boom")`],
  ["SyntaxError", `new SyntaxError("boom")`],
  ["URIError", `new URIError("boom")`],
  ["EvalError", `new EvalError("boom")`],
  ["ReferenceError", `new ReferenceError("boom")`],
  ["AggregateError", `new AggregateError(errors, "boom")`],
] as const;

const NATIVE_ERROR_CONSTRUCTORS: Readonly<Record<(typeof ERROR_CASES)[number][0], Function>> = {
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  URIError,
  EvalError,
  ReferenceError,
  AggregateError,
};

describe("#3529 P5 — equivalence Error-family imports", () => {
  it.each(ERROR_CASES)("provides the production %s constructor for manual instantiation", async (name, expr) => {
    const result = await compile(
      `export function test(flag: boolean = false, errors: any = null): number {
        if (flag) throw ${expr};
        return 1;
      }`,
      { fileName: `equivalence-${name}.ts` },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const importName = `__new_${name}`;
    expect(result.imports).toContainEqual(expect.objectContaining({ module: "env", name: importName, kind: "func" }));

    const imports = buildImports(result);
    const constructorImport = (imports.env as Record<string, Function>)[importName];
    expect(constructorImport).toBeTypeOf("function");

    const error = name === "AggregateError" ? constructorImport!([], "boom", undefined) : constructorImport!("boom");
    expect(error).toBeInstanceOf(NATIVE_ERROR_CONSTRUCTORS[name]);
    expect(error).toMatchObject({ name, message: "boom" });

    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    expect((instance.exports.test as (flag: number, errors: unknown) => number)(0, null)).toBe(1);
  });
});
