import { describe, expect, it } from "vitest";

import {
  makeIrModuleBindingResolver,
  type IrLegacyModuleBindingResolver,
  type IrStableFunctionCallPlan,
} from "../src/ir/module-bindings.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { buildTypeMap } from "../src/ir/propagate.js";
import { planIrCompilation } from "../src/ir/select.js";
import { ts } from "../src/ts-api.js";

const MODULE_OPTIONS = {
  numberStorage: "f64",
  allowHostExterns: false,
  allowBuiltinMapExtern: false,
} as const;

const FINISH_NODE_AT = `
function finishNodeAt(node: any, type: any, pos: number, loc: any): any {
  node.type = type;
  node.end = pos;
  if (this.options.locations) {
    node.loc.end = loc;
  }
  if (this.options.ranges) {
    node.range[1] = pos;
  }
  return node;
}

export function finishNode(node: any, type: any, pos: number, loc: any): any {
  return finishNodeAt.call(this, node, type, pos, loc);
}

export function finishNodeAtWrapper(node: any, type: any, pos: number, loc: any): any {
  return finishNodeAt.call(this, node, type, pos, loc);
}
`;

interface Fixture {
  readonly sourceFile: ts.SourceFile;
  readonly checker: ts.TypeChecker;
  readonly resolver: IrLegacyModuleBindingResolver;
}

function fixture(source: string, numberStorage: "f64" | "i32" = "f64"): Fixture {
  const fileName = "/repo/issue-3797.ts";
  const options: ts.CompilerOptions = {
    allowJs: true,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    strict: false,
    target: ts.ScriptTarget.ES2022,
  };
  const host: ts.CompilerHost = {
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? source : undefined),
    getSourceFile: (name, languageVersion) =>
      name === fileName ? ts.createSourceFile(name, source, languageVersion, true, ts.ScriptKind.TS) : undefined,
    getDefaultLibFileName: () => "/repo/lib.d.ts",
    writeFile: () => {},
    getCurrentDirectory: () => "/repo",
    getDirectories: () => [],
    directoryExists: (name) => name === "/repo",
    realpath: (name) => name,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram([fileName], options, host);
  const sourceFile = program.getSourceFile(fileName)!;
  const checker = program.getTypeChecker();
  return {
    sourceFile,
    checker,
    resolver: makeIrModuleBindingResolver(checker, { ...MODULE_OPTIONS, numberStorage }),
  };
}

function declaration(sourceFile: ts.SourceFile, name = "finishNodeAt"): ts.FunctionDeclaration {
  const node = sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!node) throw new Error(`missing ${name}`);
  return node;
}

function stablePlan(source: string, numberStorage: "f64" | "i32" = "f64"): IrStableFunctionCallPlan | undefined {
  const graph = fixture(source, numberStorage);
  return graph.resolver.stableFunctionCallPlan(declaration(graph.sourceFile));
}

function selectionFor(source: string): { readonly funcs: ReadonlySet<string>; readonly reason?: string } {
  const graph = fixture(source);
  const selection = planIrCompilation(
    graph.sourceFile,
    {
      experimentalIR: true,
      trackFallbacks: true,
      dynamicRuntimeBuildable: true,
      dynMemberReadBuildable: true,
      resolveModuleBinding: graph.resolver,
    },
    buildTypeMap(graph.sourceFile, graph.checker),
  );
  return {
    funcs: selection.funcs,
    reason: selection.fallbacks?.find((fallback) => fallback.name === "finishNodeAt")?.reason,
  };
}

describe("#3797 stable .call target proof", () => {
  it("certifies the exact four-parameter target and its complete two-site population", () => {
    const graph = fixture(FINISH_NODE_AT);
    const target = declaration(graph.sourceFile);
    const plan = graph.resolver.stableFunctionCallPlan(target);
    expect(plan).toBeDefined();
    expect(plan).toMatchObject({ declaration: target, targetName: "finishNodeAt", arity: 4 });
    expect(plan!.signature.getParameters()).toHaveLength(4);
    expect(plan!.callSites).toHaveLength(2);
    for (const site of plan!.callSites) {
      expect(site.call.arguments).toHaveLength(5);
      expect(site.receiver.kind).toBe(ts.SyntaxKind.ThisKeyword);
      expect(site.arguments).toHaveLength(4);
      expect(graph.resolver.stableFunctionCallPlan(site.call)?.declaration).toBe(target);
    }
  });

  it("is non-fast only", () => {
    expect(stablePlan(FINISH_NODE_AT, "f64")).toBeDefined();
    expect(stablePlan(FINISH_NODE_AT, "i32")).toBeUndefined();
  });

  it("attaches the exact Program inventory identities in production mode", () => {
    const graph = fixture(FINISH_NODE_AT);
    const target = declaration(graph.sourceFile);
    const inventory = buildIrUnitInventory([graph.sourceFile], {
      checker: graph.checker,
      entrySource: graph.sourceFile,
    });
    const context = buildIrPlanningIdentityContext(inventory);
    const resolver = makeIrModuleBindingResolver(graph.checker, MODULE_OPTIONS, context);
    const plan = resolver.stableFunctionCallPlan(target);
    expect(plan?.targetUnitId).toBe(context.unitIdByDeclaration.get(target));
    expect(plan?.sourceId).toBe(context.sourceIdBySourceFile.get(graph.sourceFile));
    for (const site of plan?.callSites ?? []) {
      expect(resolver.stableFunctionCallPlan(site.call)?.targetUnitId).toBe(plan!.targetUnitId);
    }
  });

  it.each([
    ["alias", `const alias = finishNodeAt;`],
    ["bare call", `finishNodeAt(node, type, pos, loc);`],
    ["reassignment", `finishNodeAt = function (node, type, pos, loc) { return node; };`],
    ["spread", `finishNodeAt.call(this, ...[node, type, pos, loc]);`],
    ["optional", `finishNodeAt.call?.(this, node, type, pos, loc);`],
    ["arity mismatch", `finishNodeAt.call(this, node, type, pos);`],
    ["bare call property", `const invoke = finishNodeAt.call;`],
    ["nullable receiver", `finishNodeAt.call(null, node, type, pos, loc);`],
  ])("rejects %s references from the complete source population", (_label, reference) => {
    expect(
      stablePlan(`
        function finishNodeAt(node: any, type: any, pos: number, loc: any): any {
          if (this.options.locations) node.loc.end = loc;
          return node;
        }
        export function wrapper(node: any, type: any, pos: number, loc: any): any {
          ${reference}
          return node;
        }
      `),
    ).toBeUndefined();
  });

  it.each([
    ["bare this value", `const receiver = this;`],
    ["ambient-this write", `this.options = node;`],
    ["optional ambient-this read", `if (this?.options) node.type = type;`],
  ])("rejects %s outside admitted dynamic member-read roots", (_label, bodyUse) => {
    expect(
      stablePlan(`
        function finishNodeAt(node: any, type: any, pos: number, loc: any): any {
          ${bodyUse}
          return node;
        }
        export function wrapper(node: any, type: any, pos: number, loc: any): any {
          return finishNodeAt.call(this, node, type, pos, loc);
        }
      `),
    ).toBeUndefined();
  });
});

describe("#3797 finishNodeAt selector preclaim", () => {
  it("admits the exact named and nested element stores without counting an integrated 33rd function", () => {
    const selected = selectionFor(FINISH_NODE_AT);
    expect(selected.funcs.has("finishNodeAt"), selected.reason).toBe(true);
  });

  it.each([
    ["assignment as value", `return (node.type = type);`],
    ["compound write", `node.end += pos; return node;`],
    ["optional write", `node?.type = type; return node;`],
    ["nullable receiver", `node.type = type; return node;`, `node: any | null`],
    ["unsupported receiver", `makeNode().type = type; return node;`],
  ])("rejects %s before claim", (_label, statement, firstParameter = "node: any") => {
    const selected = selectionFor(`
      function makeNode(): any { return {}; }
      function finishNodeAt(${firstParameter}, type: any, pos: number, loc: any): any {
        if (this.options.locations) node.loc.end = loc;
        ${statement}
      }
      export function wrapper(node: any, type: any, pos: number, loc: any): any {
        return finishNodeAt.call(this, node, type, pos, loc);
      }
    `);
    expect(selected.funcs.has("finishNodeAt")).toBe(false);
    expect(selected.reason).toBeDefined();
  });
});
