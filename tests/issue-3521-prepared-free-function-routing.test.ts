// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { irFirstBodyIsProvenLowerable } from "../src/codegen/ir-first-gate.js";
import { compile, type CompileResult, type IrObservedOutcome } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

function firstFunction(source: string): ts.FunctionDeclaration {
  const sourceFile = ts.createSourceFile("fixture.ts", source, ts.ScriptTarget.Latest, true);
  const declaration = sourceFile.statements.find(ts.isFunctionDeclaration);
  if (!declaration) throw new Error("fixture has no function declaration");
  return declaration;
}

function outcome(result: CompileResult, name: string): IrObservedOutcome {
  const observed = result.irOutcomes?.find(
    (candidate) => candidate.unitKind === "function" && candidate.displayName === name,
  );
  if (!observed) throw new Error(`missing outcome for ${name}`);
  return observed;
}

async function instantiate(result: CompileResult): Promise<Record<string, Function>> {
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  const exports = instance.exports as Record<string, Function>;
  (imports as { setExports?: (value: Record<string, Function>) => void }).setExports?.(exports);
  return exports;
}

describe("#3521 prepare-before-emit free-function routing", () => {
  it("IR-owns a string-method body outside the retired primitive skip allowlist", async () => {
    const code = `function codeAtStart(value: string): number { return value.charCodeAt(0); }`;
    expect(irFirstBodyIsProvenLowerable(firstFunction(code), new Map([["codeAtStart", 1]]))).toBe(false);

    const result = await compile(
      `${code}
       export function run(): number { return codeAtStart("A"); }`,
      {
        fileName: "prepared-string-method.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
        target: "standalone",
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    expect(result.irFirstSkipped).toContain("codeAtStart");
    expect(outcome(result, "codeAtStart")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect((await instantiate(result)).run()).toBe(65);
  });

  it("direct-emits a selector-unsupported free function once", async () => {
    const result = await compile(`export function withDefault(value: number = 41): number { return value + 1; }`, {
      fileName: "prepared-direct.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irFirstSkipped ?? []).not.toContain("withDefault");
    expect(outcome(result, "withDefault")).toMatchObject({
      kind: "unsupported",
      stage: "select",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
  });

  it("preserves the existing fast-mode boolean compile-once population", async () => {
    const result = await compile(`export function flag(value: boolean): boolean { return !value; }`, {
      fileName: "prepared-fast-boolean.ts",
      experimentalIR: true,
      fast: true,
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irFirstSkipped).toContain("flag");
    expect(outcome(result, "flag")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect((await instantiate(result)).flag!(0)).toBe(1);
  });

  it("keeps fast-mode numeric ABI drift on the post-direct overlay", async () => {
    const result = await compile(`export function add(left: number, right: number): number { return left + right; }`, {
      fileName: "prepared-fast-number.ts",
      experimentalIR: true,
      fast: true,
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irFirstSkipped ?? []).not.toContain("add");
    expect(outcome(result, "add")).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect((await instantiate(result)).add!(20, 22)).toBe(42);
  });

  it("keeps fast boolean callers with a numeric ABI-drift callee on the post-direct overlay", async () => {
    const result = await compile(
      `
      function numeric(value: number): number { return value + 1; }
      export function positive(value: boolean): boolean {
        return numeric(value ? 1 : 0) > 0;
      }
      `,
      {
        fileName: "prepared-fast-mixed-component.ts",
        experimentalIR: true,
        fast: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irFirstSkipped ?? []).not.toContain("numeric");
    expect(result.irFirstSkipped ?? []).not.toContain("positive");
    expect(outcome(result, "numeric")).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(outcome(result, "positive")).toMatchObject({
      legacyBodyEmitted: true,
    });
    expect((await instantiate(result)).positive!(1)).toBe(1);
  });

  it("keeps an implicit-any component with an allocated ABI mismatch on the post-direct overlay", async () => {
    const result = await compile(
      `
      function sameValue(left, right) { return left === right; }
      function compare(left, right) { return sameValue(left, right); }
      export function run(): number { return compare(1, 1) ? 42 : 0; }
      `,
      {
        fileName: "prepared-allocated-abi-mismatch.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irFirstSkipped ?? []).not.toContain("sameValue");
    expect(result.irFirstSkipped ?? []).not.toContain("compare");
    expect(outcome(result, "sameValue")).toMatchObject({
      kind: "unsupported",
      code: "abi-signature-parity",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(outcome(result, "compare")).toMatchObject({
      legacyBodyEmitted: true,
    });
    expect((await instantiate(result)).run!()).toBe(42);
  });

  it("preserves the existing sync-pass-through async compile-once population", async () => {
    const result = await compile(`export async function answer(): Promise<number> { return 42; }`, {
      fileName: "prepared-async-pass-through.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
    });

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.irFirstSkipped).toContain("answer");
    expect(outcome(result, "answer")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect((await instantiate(result)).answer!()).toBe(42);
  });

  it("keeps module-global and class-owned dependencies on the post-direct overlay", async () => {
    const moduleGlobal = await compile(
      `
      let answer = 42;
      export function readAnswer(): number { return answer; }
      `,
      {
        fileName: "prepared-module-global-boundary.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );
    expect(moduleGlobal.success, moduleGlobal.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(moduleGlobal.irFirstSkipped ?? []).not.toContain("readAnswer");
    expect(outcome(moduleGlobal, "readAnswer")).toMatchObject({
      legacyBodyEmitted: true,
      irBodyEmitted: true,
    });
    expect((await instantiate(moduleGlobal)).readAnswer!()).toBe(42);

    const classOwned = await compile(
      `
      class Answer { value(): number { return 42; } }
      export function readClass(): number { return new Answer().value(); }
      `,
      {
        fileName: "prepared-class-boundary.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      },
    );
    expect(classOwned.success, classOwned.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(classOwned.irFirstSkipped ?? []).not.toContain("readClass");
    expect(outcome(classOwned, "readClass")).toMatchObject({
      legacyBodyEmitted: true,
      irBodyEmitted: true,
    });
    expect((await instantiate(classOwned)).readClass!()).toBe(42);
  });

  it("keeps prepared bodies valid when a later direct owner adds a host import", async () => {
    const result = await compile(
      `
      export function codeAtStart(value: string): number {
        return value.charCodeAt(0);
      }
      export function caller(value: string): number {
        return codeAtStart(value);
      }
      export function lateDirect(value: any = "A"): boolean {
        return value === "A";
      }
      `,
      {
        fileName: "prepared-before-late-import.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
        target: "gc",
      },
    );

    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.imports.some((entry) => entry.name === "__extern_is_undefined")).toBe(true);
    expect(outcome(result, "codeAtStart")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(outcome(result, "caller")).toMatchObject({
      kind: "emitted",
      legacyBodyEmitted: false,
      irBodyEmitted: true,
    });
    expect(outcome(result, "lateDirect")).toMatchObject({
      kind: "unsupported",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    const exports = await instantiate(result);
    expect(exports.caller!("A")).toBe(65);
    expect(exports.lateDirect!()).toBe(1);
  });

  it("fails a preparation invariant without retrying the direct body emitter", async () => {
    const previous = process.env.JS2WASM_TEST_INJECT_IR_BUILD_THROW;
    process.env.JS2WASM_TEST_INJECT_IR_BUILD_THROW = "1";
    let result: CompileResult;
    try {
      result = await compile(`export function add(a: number, b: number): number { return a + b; }`, {
        fileName: "prepared-invariant.ts",
        experimentalIR: true,
        trackIrOutcomes: true,
      });
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_TEST_INJECT_IR_BUILD_THROW");
      else process.env.JS2WASM_TEST_INJECT_IR_BUILD_THROW = previous;
    }

    expect(result.success).toBe(false);
    expect(result.irFirstSkipped).toContain("add");
    expect(outcome(result, "add")).toMatchObject({
      kind: "invariant",
      code: "unexpected-internal-throw",
      stage: "build",
      legacyBodyEmitted: false,
      irBodyEmitted: false,
    });
  });
});
