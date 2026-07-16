// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compileAndRunHost as compileAndRun } from "./helpers/compile.js";

/**
 * #2756 — array-pattern element with an object-literal / class-expression default
 * value null-derefs (carved from the #2669 destructuring umbrella).
 *
 * Root cause: an empty/short array literal `[]` is represented as a 1-tuple
 * struct whose `_0` field is a nullable ref. In the tuple-struct destructuring
 * path (`destructureParamArray`) an identifier element with a default had its
 * field value coerced field→local BEFORE the null→default check. For a
 * `ref_null`→`ref` (non-null) local that coercion is a `ref.as_non_null`, which
 * TRAPS on the wasm-null (absent) slot before the default can fire —
 * `let [c = {a:1}] = []` ⇒ "dereferencing a null pointer". Numeric and
 * array-literal defaults were already safe; the bug surfaced for object-literal
 * and class-expression defaults (the test262 `*-init-fn-name-class` cluster).
 *
 * Fix: route the ref-field-with-default case through `emitDefaultValueCheck`,
 * which tees the field, checks `ref.is_null`, applies the default in the missing
 * arm, and coerces to the local type ONLY in the value-present arm. Plus a
 * NamedEvaluation refinement (#2756): a class expression that declares its own
 * `static name` member (or is a named class) does NOT receive the binding name
 * (§15.7.14 ClassDefinitionEvaluation defines static members AFTER
 * SetFunctionName, overriding `.name`).
 */

describe("#2756 — array-pattern object/class default null-deref", () => {
  it("object-literal default fires when element absent (was null-deref)", async () => {
    const e = await compileAndRun(`export function test(): number { let [c = {a:1}] = []; return (c as any).a; }`);
    expect(e.test!()).toBe(1);
  });

  it("object-literal default skipped when element present", async () => {
    const e = await compileAndRun(`export function test(): number { let [c = {a:1}] = [{a:9}]; return (c as any).a; }`);
    expect(e.test!()).toBe(9);
  });

  it("partial source: absent element with object default", async () => {
    const e = await compileAndRun(
      `export function test(): number { let [a, c = {x:9}] = [1]; return (a as number) + (c as any).x; }`,
    );
    expect(e.test!()).toBe(10);
  });

  it("array-literal default still works (regression guard)", async () => {
    const e = await compileAndRun(`export function test(): number { let [c = [1,2]] = []; return (c as any)[1]; }`);
    expect(e.test!()).toBe(2);
  });

  it("numeric default still works (regression guard)", async () => {
    const e = await compileAndRun(`export function test(): number { let [a = 5] = [] as number[]; return a; }`);
    expect(e.test!()).toBe(5);
  });

  it("class-expression default fires + materializes (new + method call)", async () => {
    const e = await compileAndRun(
      `export function test(): number { let [c = class { m(): number { return 8; } }] = [] as any[]; return new (c as any)().m(); }`,
    );
    expect(e.test!()).toBe(8);
  });
});

describe("#2756 — NamedEvaluation of class defaults in array destructuring", () => {
  it("anonymous class default inherits the binding name", async () => {
    const e = await compileAndRun(`export function test(): string { let [cls = class {}] = []; return cls.name; }`);
    expect(e.test!()).toBe("cls");
  });

  it("named class expression keeps its own name", async () => {
    const e = await compileAndRun(`export function test(): string { let [xCls = class X {}] = []; return xCls.name; }`);
    expect(e.test!()).toBe("X");
  });

  it("class with a static `name` member is NOT renamed to the binding", async () => {
    // §15.7.14: static members are defined AFTER SetFunctionName, so the static
    // `name` overrides the NamedEvaluation binding name. Must NOT be 'xCls2'.
    const e = await compileAndRun(
      `export function test(): number { let [xCls2 = class { static name(): number { return 0; } }] = []; return xCls2.name === 'xCls2' ? 1 : 0; }`,
    );
    expect(e.test!()).toBe(0);
  });

  it("anonymous function default inherits the binding name (unchanged)", async () => {
    const e = await compileAndRun(`export function test(): string { let [fn = function () {}] = []; return fn.name; }`);
    expect(e.test!()).toBe("fn");
  });
});
