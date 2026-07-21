// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { analyzeSource } from "../src/checker/index.js";
import { compile, type IrObservedOutcome } from "../src/index.js";
import { lowerFunctionAstToIr } from "../src/ir/from-ast.js";
import { classifyIrFailure, type IrUnsupportedCode } from "../src/ir/outcomes.js";

function terminalFor(result: Awaited<ReturnType<typeof compile>>, displayName = "test"): IrObservedOutcome {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const outcome = result.irOutcomes?.find((candidate) => candidate.displayName === displayName);
  expect(outcome, `missing terminal outcome for ${displayName}`).toBeDefined();
  return outcome!;
}

async function expectBuildUnsupported(source: string, code: IrUnsupportedCode): Promise<void> {
  const result = await compile(source, { fileName: `${code}.ts`, trackIrOutcomes: true });
  expect(terminalFor(result)).toMatchObject({
    kind: "unsupported",
    code,
    stage: "build",
    legacyBodyEmitted: true,
    irBodyEmitted: false,
  });
}

function lowerDirect(source: string): void {
  const ast = analyzeSource(source, "direct-string-method.ts");
  const declaration = ast.sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === "test",
  );
  expect(declaration).toBeDefined();
  lowerFunctionAstToIr(declaration!, { exported: true });
}

describe("#3529 P2 — typed dataflow outcomes", () => {
  it.each([
    {
      name: "mixed string equality",
      code: "operand-coercion-unsupported" as const,
      source: `export function test(): number { return 0 == "" ? 1 : 0; }`,
    },
    {
      name: "object/number relational coercion",
      code: "operand-coercion-unsupported" as const,
      source: `
        class Box { valueOf(): number { return 1; } }
        export function test(): number { return new Box() > 0 ? 1 : 0; }
      `,
    },
    {
      name: "class/number additive coercion",
      code: "operand-coercion-unsupported" as const,
      source: `
        class Box { valueOf(): number { return 1; } }
        export function test(): number { return new Box() + 3; }
      `,
    },
    {
      name: "string append without producer encoding evidence",
      code: "string-evidence-unsupported" as const,
      source: `
        export function test(): string {
          let text = "";
          for (let i = 0; i < 2; i++) text += i;
          return text;
        }
      `,
    },
    {
      name: "array reference property write",
      code: "property-write-unsupported" as const,
      source: `
        export function test(): number {
          const values: number[] = [1, 2];
          values.length = 0;
          return values.length;
        }
      `,
    },
  ])("records $name at the exact producer gate", async ({ source, code }) => {
    await expectBuildUnsupported(source, code);
  });

  it.each([
    ["+", `return +new Box();`],
    ["-", `return -new Box();`],
    ["!", `return !new Box() ? 1 : 0;`],
  ])("records unary %s coercion as unsupported", async (_operator, body) => {
    await expectBuildUnsupported(
      `
        class Box { valueOf(): number { return 1; } }
        export function test(): number { ${body} }
      `,
      "operand-coercion-unsupported",
    );
  });

  it.each([
    ["bare null", `export function test(): number { return +null; }`],
    [
      "undefined-valued expression",
      `export function test(x: number): number { return (void x) === undefined ? 1 : 0; }`,
    ],
    ["null versus ambient undefined", `export function test(): number { return null === undefined ? 1 : 0; }`],
  ])("records %s as an unsupported nullish representation", async (_name, source) => {
    await expectBuildUnsupported(source, "nullish-value-unsupported");
  });

  it("materializes reassigned vector references as slots instead of violating the mutation invariant", async () => {
    const result = await compile(
      `
        export function test(): number {
          let values: number[] = [1, 2, 3, 4];
          let sum = 0;
          for (let i = 0; i < values.length; i++) {
            sum += values[i];
            if (i === 1) values = [9, 9];
          }
          return sum;
        }
      `,
      { fileName: "mutable-vector-slot.ts", trackIrOutcomes: true },
    );

    expect(terminalFor(result)).toMatchObject({
      kind: "emitted",
      irBodyEmitted: true,
    });
  });

  it.each(["toString", "valueOf"])("does not treat inherited String.%s as a method-table signature", (methodName) => {
    let thrown: unknown;
    try {
      lowerDirect(`
          export function test(): string {
            const value = "hello";
            return value.${methodName}();
          }
        `);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toContain(`method call .${methodName}(...) on string not in slice 4`);
    expect(classifyIrFailure(thrown, "build")).toMatchObject({
      kind: "invariant",
      code: "unexpected-internal-throw",
      stage: "build",
    });
  });

  it("keeps an unknown producer throw classified as an invariant", () => {
    expect(classifyIrFailure(new Error("malformed promised IR shape"), "build")).toMatchObject({
      kind: "invariant",
      code: "unexpected-internal-throw",
      stage: "build",
      detail: "malformed promised IR shape",
    });
  });
});
