// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it } from "vitest";

import { formatIrPathFallbackDiagnostic } from "../src/codegen/index.js";
import { compile, type IrInvariantCode, type IrObservedOutcome } from "../src/index.js";
import { evaluateIrOutcomePolicy } from "../src/ir/outcomes.js";

const ORIGINAL_TYPEMAP_INJECTION = process.env.JS2WASM_TEST_INJECT_IR_TYPEMAP_THROW;

function terminal(result: Awaited<ReturnType<typeof compile>>): readonly IrObservedOutcome[] {
  expect(result.irOutcomes).toBeDefined();
  return result.irOutcomes ?? [];
}

function invariant(code: IrInvariantCode, detail: string): IrObservedOutcome {
  return {
    key: `fixture::function::f#0`,
    file: "fixture.ts",
    unitKind: "function",
    displayName: "f",
    ordinal: 0,
    line: 1,
    column: 1,
    backend: "wasmgc",
    target: "gc",
    legacyBodyEmitted: true,
    irBodyEmitted: false,
    kind: "invariant",
    code,
    stage: code === "backend-legality-failure" ? "backend-legality" : "patch",
    detail,
  };
}

afterEach(() => {
  if (ORIGINAL_TYPEMAP_INJECTION === undefined) {
    Reflect.deleteProperty(process.env, "JS2WASM_TEST_INJECT_IR_TYPEMAP_THROW");
  } else {
    process.env.JS2WASM_TEST_INJECT_IR_TYPEMAP_THROW = ORIGINAL_TYPEMAP_INJECTION;
  }
});

describe("#3519 typed IR terminal outcomes", () => {
  it("accounts a supported free function once and both policies consume the same row", async () => {
    const result = await compile(`export function add(a: number, b: number): number { return a + b; }`, {
      fileName: "supported.ts",
      trackIrOutcomes: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const outcomes = terminal(result);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      unitKind: "function",
      displayName: "add",
      kind: "emitted",
      irBodyEmitted: true,
    });
    expect(evaluateIrOutcomePolicy(outcomes, "hybrid").ready).toBe(true);
    expect(evaluateIrOutcomePolicy(outcomes, "ir-only").ready).toBe(outcomes[0]!.legacyBodyEmitted === false);
  });

  it("records a selector rejection as Unsupported while production hybrid succeeds", async () => {
    const result = await compile(`export function withDefault(x: number = 1): number { return x; }`, {
      fileName: "selector-reject.ts",
      trackIrOutcomes: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const outcomes = terminal(result);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      kind: "unsupported",
      stage: "select",
      code: "param-shape-rejected",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });
    expect(evaluateIrOutcomePolicy(outcomes, "hybrid").ready).toBe(true);
    expect(evaluateIrOutcomePolicy(outcomes, "ir-only").ready).toBe(false);
  });

  it("types the post-claim void-call expression gap without inspecting its message", async () => {
    const result = await compile(
      `
class Animal {
  age: number;
  constructor(age: number) { this.age = age; }
}
class Dog extends Animal {
  constructor(age: number) {
    super(age);
  }
}
export function value(): number { return new Dog(4).age; }
`,
      { fileName: "void-call.ts", trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const gap = terminal(result).find((outcome) => outcome.displayName === "Dog_new" && outcome.kind === "unsupported");
    expect(gap).toMatchObject({ kind: "unsupported", code: "void-call-expression", stage: "build" });
    expect(gap && evaluateIrOutcomePolicy([gap], "hybrid").ready).toBe(true);
    expect(gap && evaluateIrOutcomePolicy([gap], "ir-only").ready).toBe(false);
  });

  it("accounts class members and a non-empty module initializer exactly once", async () => {
    const result = await compile(
      `
let seed: number = 3;
class Counter {
  value: number;
  constructor(value: number) { this.value = value; }
  read(): number { return this.value; }
  static zero(): number { return 0; }
}
export function readSeed(): number { return seed; }
`,
      { fileName: "class-module.ts", trackIrOutcomes: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    const outcomes = terminal(result);
    expect(outcomes.filter((outcome) => outcome.unitKind === "module-init")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.unitKind === "class-member")).toHaveLength(3);
    expect(outcomes.find((outcome) => outcome.displayName === "Counter_zero")).toMatchObject({
      kind: "unsupported",
      code: "static-class-member",
      stage: "build",
    });
    expect(new Set(outcomes.map((outcome) => outcome.key)).size).toBe(outcomes.length);
  });

  it("does not count compiler-injected timer wrappers as user source units", async () => {
    const result = await compile(`export function delayed(): void { setTimeout(() => {}, 1); }`, {
      fileName: "timer.ts",
      trackIrOutcomes: true,
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(terminal(result).map((outcome) => outcome.displayName)).toEqual(["delayed"]);
  });

  it("preserves typed TypeMap invariants on a failed CompileResult", async () => {
    process.env.JS2WASM_TEST_INJECT_IR_TYPEMAP_THROW = "1";
    const result = await compile(`export function f(x: number): number { return x; }`, {
      fileName: "typemap-failure.ts",
      trackIrOutcomes: true,
    });
    expect(result.success).toBe(false);
    expect(terminal(result)).toEqual([
      expect.objectContaining({ kind: "invariant", code: "type-map-failure", stage: "resolve" }),
    ]);
  });

  it("makes invariant policy independent of diagnostic wording", () => {
    const codes: IrInvariantCode[] = [
      "unknown-function-ref",
      "unknown-global-ref",
      "unknown-type-ref",
      "verifier-failure",
      "backend-legality-failure",
      "missing-function-slot",
      "unpatched-slot",
      "abi-type-index-mismatch",
    ];
    for (const [index, code] of codes.entries()) {
      for (const detail of [`wording A ${index}`, `completely changed diagnostic ${index}`]) {
        const outcome = invariant(code, detail);
        expect(evaluateIrOutcomePolicy([outcome], "hybrid").ready).toBe(false);
        expect(evaluateIrOutcomePolicy([outcome], "ir-only").ready).toBe(false);
        const diagnostic = formatIrPathFallbackDiagnostic({
          func: "f",
          message: detail,
          kind: outcome.stage === "backend-legality" ? "backend-legality" : "lower",
          outcome,
        });
        expect(diagnostic.severity).toBe("error");
      }
    }
  });
});
