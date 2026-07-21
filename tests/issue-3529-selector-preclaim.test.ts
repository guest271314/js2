// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { compile, type IrObservedOutcome, type IrUnsupportedCode } from "../src/index.js";
import { classifyIrFailure, evaluateIrOutcomePolicy } from "../src/ir/outcomes.js";
import { planIrCompilation } from "../src/ir/select.js";
import { ts } from "../src/ts-api.js";

function outcomes(result: Awaited<ReturnType<typeof compile>>): readonly IrObservedOutcome[] {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irOutcomes).toBeDefined();
  return result.irOutcomes ?? [];
}

function expectSelectUnsupported(
  observed: readonly IrObservedOutcome[],
  displayName: string,
  code: IrUnsupportedCode,
): void {
  const outcome = observed.find((entry) => entry.displayName === displayName);
  expect(outcome).toMatchObject({
    kind: "unsupported",
    stage: "select",
    code,
    legacyBodyEmitted: true,
    irBodyEmitted: false,
  });
  expect(outcome && evaluateIrOutcomePolicy([outcome], "hybrid").ready).toBe(true);
  expect(outcome && evaluateIrOutcomePolicy([outcome], "ir-only").ready).toBe(false);
}

const PRECLAIM_CASES: ReadonlyArray<{
  readonly name: string;
  readonly code: IrUnsupportedCode;
  readonly source: string;
}> = [
  {
    name: "ambient String method",
    code: "string-method-unsupported",
    source: `export function test(): string { return "x".repeat(2); }`,
  },
  {
    name: "ambient Array method",
    code: "array-method-unsupported",
    source: `export function test(): number { const values = [1, 2]; return values.indexOf(2); }`,
  },
  {
    name: "numeric primitive method",
    code: "primitive-method-unsupported",
    source: `export function test(): number { return (1).valueOf(); }`,
  },
  {
    name: "Function.call",
    code: "function-invocation-method-unsupported",
    source: `export function test(): number {
      const inc = (value: number): number => value + 1;
      return inc.call(undefined, 1);
    }`,
  },
  {
    name: "logical value result",
    code: "logical-value-unsupported",
    source: `export function test(): number { return 0 || 42; }`,
  },
  {
    name: "template coercion",
    code: "template-substitution-unsupported",
    source: "export function test(value: number): string { return `value=${value}`; }",
  },
  {
    name: "ambient Error constructor",
    code: "error-constructor-unsupported",
    source: `export function test(): number { const error = new TypeError("bad"); return error.message.length; }`,
  },
  {
    name: "ambient TypedArray constructor",
    code: "typed-array-constructor-unsupported",
    source: `export function test(): number { const values = new Uint8Array(1); return values.length; }`,
  },
  {
    name: "direct call arity",
    code: "call-arity-unsupported",
    source: `function add(a: number, b: number): number { return a + b; }
      export function test(): number { return add(1); }`,
  },
  {
    name: "constructor arity",
    code: "constructor-arity-unsupported",
    source: `class Pair {
      a: number;
      b: number;
      constructor(a: number, b: number) { this.a = a; this.b = b; }
    }
    export function test(): number { const pair = new Pair(1); return pair.a; }`,
  },
  {
    name: "computed class member",
    code: "class-member-unsupported",
    source: `class Greeter { ["value"](): number { return 42; } }
      export function test(): number { const greeter = new Greeter(); return greeter.value(); }`,
  },
  {
    name: "nested forward call",
    code: "call-resolution-unsupported",
    source: `export function test(): number {
      function first(value: number): number { return second(value); }
      function second(value: number): number { return value + 1; }
      return first(1);
    }`,
  },
  {
    name: "class shape projection",
    code: "class-projection-unsupported",
    source: `class Builder {
      value: number;
      constructor(value: number) { this.value = value; }
      add(value: number): Builder { return new Builder(this.value + value); }
    }
    export function test(): number { return new Builder(1).add(2).value; }`,
  },
];

describe("#3529 selector preclaim capability parity", () => {
  it.each(PRECLAIM_CASES)("types $name before AST-to-IR build", async ({ code, source }) => {
    const result = await compile(source, { fileName: `${code}.ts`, trackIrOutcomes: true });
    expectSelectUnsupported(outcomes(result), "test", code);
  });

  it("uses the Date backend-capability seam on host-free targets", async () => {
    const sourceFile = ts.createSourceFile(
      "date-capability-direct.ts",
      `export function test(): number { const date = new Date(); return date.getFullYear(); }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const selection = planIrCompilation(sourceFile, {
      experimentalIR: true,
      trackFallbacks: true,
      isAmbientBinding: (node) => node.text === "Date",
      hostDateSnapshots: (expression) => ({ expression, getterCalls: new Set() }),
      supportsBackendCapability: () => false,
    });
    expect(selection.fallbacks?.find((fallback) => fallback.name === "test")?.reason).toBe(
      "date-constructor-unsupported",
    );

    const result = await compile(`export function test(): number { const date = new Date(); return date.getTime(); }`, {
      fileName: "date-capability.ts",
      target: "standalone",
      trackIrOutcomes: true,
    });
    expectSelectUnsupported(outcomes(result), "test", "date-constructor-unsupported");
  });

  it("keeps same-named user classes and methods IR-claimable", async () => {
    const result = await compile(
      `class Custom {
        trim(): number { return 1; }
        map(): number { return 2; }
        call(): number { return 3; }
        apply(): number { return 4; }
      }
      export function canary(): number {
        const custom = new Custom();
        return custom.trim() + custom.map() + custom.call() + custom.apply();
      }`,
      { fileName: "shadow-canary.ts", trackIrOutcomes: true },
    );
    expect(outcomes(result).find((entry) => entry.displayName === "canary")).toMatchObject({
      kind: "emitted",
      stage: "patch",
      irBodyEmitted: true,
    });
  });

  it("uses declaration identity rather than builtin constructor names", () => {
    const sourceFile = ts.createSourceFile(
      "constructor-shadows.ts",
      `class Error { value: number; constructor(value: number) { this.value = value; } }
      class Uint8Array { value: number; constructor(value: number) { this.value = value; } }
      class Date { value: number; constructor() { this.value = 5; } }
      export function canary(): number {
        const error = new Error(6);
        const bytes = new Uint8Array(7);
        const date = new Date();
        return error.value + bytes.value + date.value;
      }`,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const selection = planIrCompilation(sourceFile, {
      experimentalIR: true,
      trackFallbacks: true,
      isAmbientBinding: () => false,
    });
    expect(selection.funcs.has("canary")).toBe(true);
    expect(selection.fallbacks?.find((fallback) => fallback.name === "canary")).toBeUndefined();
  });

  it("keeps unknown internal throws classified as invariants", () => {
    expect(classifyIrFailure(new TypeError("malformed producer state"), "build")).toMatchObject({
      kind: "invariant",
      stage: "build",
      code: "unexpected-internal-throw",
    });
  });
});
