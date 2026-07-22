// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import type {
  IrHostVoidCallbackLoweringPlan,
  IrImportedCallLoweringPlan,
  IrTopLevelFunctionValueLoweringPlan,
} from "../src/ir/ast-lowering-plans.js";
import { lowerFunctionAstToIr, type IrExternClassMeta, type LoweredFunctionResult } from "../src/ir/from-ast.js";
import type { IrUnitId } from "../src/ir/identity.js";
import { irVal, type IrClosureSignature, type IrType } from "../src/ir/nodes.js";
import { ts } from "../src/ts-api.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const irIdentities = createTestIrFunctionIdentityFactory("issue-3520-lowering-plan");
const OWNER_ID = irIdentities.unit(0);
const STALE_OWNER_ID = irIdentities.unit(1);
const TARGET_ID = irIdentities.unit(2);

const F64: IrType = irVal({ kind: "f64" });
const NUMBER_SIGNATURE: IrClosureSignature = { params: [], returnType: F64 };
const VOID_SIGNATURE: IrClosureSignature = { params: [], returnType: null };
const CALLABLE_NUMBER: IrType = { kind: "callable", signature: NUMBER_SIGNATURE };

function sourceFunction(source: string): ts.FunctionDeclaration {
  const sourceFile = ts.createSourceFile("issue-3520-lowering-plan.ts", source, ts.ScriptTarget.ES2022, true);
  const declaration = sourceFile.statements.find(ts.isFunctionDeclaration);
  if (!declaration) throw new Error("expected a function declaration");
  return declaration;
}

function firstDescendant<T extends ts.Node>(node: ts.Node, predicate: (candidate: ts.Node) => candidate is T): T {
  let match: T | undefined;
  const visit = (candidate: ts.Node): void => {
    if (match) return;
    if (predicate(candidate)) {
      match = candidate;
      return;
    }
    ts.forEachChild(candidate, visit);
  };
  visit(node);
  if (!match) throw new Error("expected matching descendant");
  return match;
}

function planOwnerEvidence(ownerUnitId: IrUnitId | undefined): { readonly ownerUnitId?: IrUnitId } {
  return ownerUnitId === undefined ? {} : { ownerUnitId };
}

function importedCallFixture(): {
  lower(planOwnerUnitId: IrUnitId | undefined): LoweredFunctionResult;
  plan(planOwnerUnitId: IrUnitId | undefined): IrImportedCallLoweringPlan;
} {
  const declaration = sourceFunction(`export function owner(): number { return importedTarget(); }`);
  const call = firstDescendant(declaration, ts.isCallExpression);
  const plan = (ownerUnitId: IrUnitId | undefined): IrImportedCallLoweringPlan =>
    ({
      ...planOwnerEvidence(ownerUnitId),
      ownerName: "owner",
      targetUnitId: TARGET_ID,
      targetName: "importedTarget",
      params: [],
      returnType: F64,
      optionalParams: new Map(),
      needsArgc: false,
    }) as IrImportedCallLoweringPlan;
  return {
    plan,
    lower: (planOwnerUnitId) =>
      lowerFunctionAstToIr(declaration, {
        ownerUnitId: OWNER_ID,
        exported: true,
        importedCalls: new Map([[call, plan(planOwnerUnitId)]]),
      }),
  };
}

function functionValueFixture(): {
  lower(planOwnerUnitId: IrUnitId | undefined): LoweredFunctionResult;
  plan(planOwnerUnitId: IrUnitId | undefined): IrTopLevelFunctionValueLoweringPlan;
} {
  const declaration = sourceFunction(`export function owner() { return target; }`);
  const target = firstDescendant(
    declaration,
    (node): node is ts.Identifier => ts.isIdentifier(node) && node.text === "target",
  );
  const plan = (ownerUnitId: IrUnitId | undefined): IrTopLevelFunctionValueLoweringPlan =>
    ({
      ...planOwnerEvidence(ownerUnitId),
      ownerName: "owner",
      targetUnitId: TARGET_ID,
      targetName: "target",
      signature: NUMBER_SIGNATURE,
      trampolineName: "__fn_tramp_target_cached",
      cacheGlobalName: "__fn_closure_target",
    }) as IrTopLevelFunctionValueLoweringPlan;
  return {
    plan,
    lower: (planOwnerUnitId) =>
      lowerFunctionAstToIr(declaration, {
        ownerUnitId: OWNER_ID,
        exported: true,
        returnTypeOverride: CALLABLE_NUMBER,
        topLevelFunctionValues: new Map([[target, plan(planOwnerUnitId)]]),
      }),
  };
}

function callbackFixture(): {
  lower(planOwnerUnitId: IrUnitId | undefined): LoweredFunctionResult;
  plan(planOwnerUnitId: IrUnitId | undefined): IrHostVoidCallbackLoweringPlan;
} {
  const declaration = sourceFunction(`
    export function owner(target: EventTarget): void {
      target.addEventListener("tick", () => { return; });
      return;
    }
  `);
  const callback = firstDescendant(declaration, ts.isArrowFunction);
  const externref = { kind: "externref" } as const;
  const eventTarget: IrExternClassMeta = {
    className: "EventTarget",
    constructorParams: [],
    methods: new Map([["addEventListener", { params: [externref, externref, externref], results: [] }]]),
    properties: new Map(),
  };
  const plan = (ownerUnitId: IrUnitId | undefined): IrHostVoidCallbackLoweringPlan =>
    ({
      ...planOwnerEvidence(ownerUnitId),
      ownerName: "owner",
      signature: VOID_SIGNATURE,
      captureNames: new Set(),
      liftedOrdinal: 0,
    }) as IrHostVoidCallbackLoweringPlan;
  return {
    plan,
    lower: (planOwnerUnitId) =>
      lowerFunctionAstToIr(declaration, {
        ownerUnitId: OWNER_ID,
        exported: true,
        paramTypeOverrides: [{ kind: "extern", className: "EventTarget" }],
        returnTypeOverride: null,
        resolver: { getExternClassInfo: (className) => (className === "EventTarget" ? eventTarget : undefined) },
        hostVoidCallbacks: new Map([[callback, plan(planOwnerUnitId)]]),
      }),
  };
}

describe("#3520 lowering-plan owner identity", () => {
  it.each([
    ["imported call", importedCallFixture, 0],
    ["top-level function value", functionValueFixture, 0],
    ["host void callback", callbackFixture, 1],
  ] as const)(
    "fails closed for missing and stale %s owners, then accepts the exact owner",
    (kind, makeFixture, lifts) => {
      const fixture = makeFixture();

      expect(() => fixture.lower(undefined)).toThrow(`stale ${kind} plan owner undefined`);
      expect(() => fixture.lower(STALE_OWNER_ID)).toThrow(`stale ${kind} plan owner`);

      const lowered = fixture.lower(OWNER_ID);
      expect(lowered.main.name).toBe("owner");
      expect(lowered.lifted).toHaveLength(lifts);
    },
  );

  it("retains structural target IDs while emitting legacy backend names", () => {
    const imported = importedCallFixture();
    const importedPlan = imported.plan(OWNER_ID);
    expect(importedPlan.targetUnitId).toBe(TARGET_ID);
    const importedIr = imported.lower(OWNER_ID);
    expect(importedIr.main.blocks.flatMap((block) => block.instrs)).toContainEqual(
      expect.objectContaining({ kind: "call", target: { kind: "func", name: importedPlan.targetName } }),
    );

    const functionValue = functionValueFixture();
    const functionValuePlan = functionValue.plan(OWNER_ID);
    expect(functionValuePlan.targetUnitId).toBe(TARGET_ID);
    const functionValueIr = functionValue.lower(OWNER_ID);
    expect(functionValueIr.main.blocks.flatMap((block) => block.instrs)).toContainEqual(
      expect.objectContaining({
        kind: "global.get",
        target: { kind: "global", name: functionValuePlan.cacheGlobalName },
        resultType: CALLABLE_NUMBER,
      }),
    );
  });
});
