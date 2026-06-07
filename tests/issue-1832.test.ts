import { describe, expect, it } from "vitest";
import { collectReferencedIdentifiers, isOwnParamName } from "../src/codegen/closures.js";
import { forEachChild, ts } from "../src/ts-api.js";

function findFunctionExpression(source: string): ts.FunctionExpression {
  const sf = ts.createSourceFile("issue-1832.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  let found: ts.FunctionExpression | undefined;

  function visit(node: ts.Node): void {
    if (found) return;
    if (ts.isFunctionExpression(node)) {
      found = node;
      return;
    }
    forEachChild(node, visit);
  }

  visit(sf);
  if (!found) throw new Error("test source did not contain a function expression");
  return found;
}

function newFunctionCaptureCandidates(source: string, outerNames: readonly string[]): string[] {
  const funcExpr = findFunctionExpression(source);
  const referenced = new Set<string>();
  for (const stmt of funcExpr.body?.statements ?? []) {
    collectReferencedIdentifiers(stmt, referenced);
  }

  return [...referenced]
    .filter((name) => outerNames.includes(name))
    .filter((name) => !isOwnParamName(funcExpr, name))
    .sort();
}

describe("#1832 - new FunctionExpression destructured params shadow captures", () => {
  it("does not capture an outer name shadowed by an object binding parameter", () => {
    const source = `
      export function test(): void {
        const a: number = 1;
        new (function({ a }: { a: number }) {
          return a;
        })({ a: 2 });
      }
    `;

    expect(newFunctionCaptureCandidates(source, ["a"])).toEqual([]);
  });

  it("keeps renamed and nested object binding names out of capture candidates", () => {
    const source = `
      export function test(): void {
        const a: number = 1;
        const b: number = 2;
        const outer: number = 3;
        new (function({ value: a, nested: { b } }: { value: number; nested: { b: number } }) {
          return a + b + outer;
        })({ value: 4, nested: { b: 5 } });
      }
    `;

    expect(newFunctionCaptureCandidates(source, ["a", "b", "outer"])).toEqual(["outer"]);
  });

  it("keeps nested array binding names out of capture candidates", () => {
    const source = `
      export function test(): void {
        const a: number = 1;
        const b: number = 2;
        const outer: number = 3;
        new (function([a, [, b]]: [number, [number, number]]) {
          return a + b + outer;
        })([4, [5, 6]]);
      }
    `;

    expect(newFunctionCaptureCandidates(source, ["a", "b", "outer"])).toEqual(["outer"]);
  });
});
