// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrUnitId } from "./identity.js";
import type { IrClosureSignature, IrFuncRef, IrType } from "./nodes.js";
import type { IrLegacyUnitProjection, IrPlanningIdentityContext } from "./planning-identity.js";
import type { IrPromiseDelayLoweringPlans } from "./promise-delay-lowering.js";
import { ts } from "../ts-api.js";

export interface IrImportedOptionalParamPlan {
  readonly constantDefault?:
    | { readonly kind: "f64"; readonly value: number }
    | { readonly kind: "i32"; readonly value: number };
  readonly hasExpressionDefault?: boolean;
}

export interface IrImportedCallLoweringPlan {
  readonly ownerUnitId: IrUnitId;
  readonly ownerName: string;
  /** Exact source-unit target. `name` is diagnostic/adapter metadata only. */
  readonly target: IrFuncRef;
  readonly params: readonly IrType[];
  readonly returnType: IrType | null;
  readonly optionalParams: ReadonlyMap<number, IrImportedOptionalParamPlan>;
  readonly needsArgc: boolean;
}

export interface IrTopLevelFunctionValueLoweringPlan {
  readonly ownerUnitId: IrUnitId;
  readonly ownerName: string;
  /** Exact source-unit function whose value is being materialized. */
  readonly target: IrFuncRef;
  readonly signature: IrClosureSignature;
  /** Exact compiler-owned trampoline used by `closure.new`. */
  readonly trampoline: IrFuncRef;
  readonly cacheGlobalName: string;
}

/** Exact direct-call plan for one certified AST call site. */
export interface IrDirectCallLoweringPlan {
  readonly ownerUnitId: IrUnitId;
  /** Exact closed-union callable target. `name` is adapter metadata only. */
  readonly target: IrFuncRef;
  readonly signature: IrClosureSignature;
}

/** Already-validated callable target supplied by integration planning. */
export interface IrDirectCallTarget {
  readonly target: IrFuncRef;
  readonly signature: IrClosureSignature;
}

/**
 * Build exact-node direct-call plans without deriving identity from a label.
 * The target map is authoritative and must already contain a structural
 * source-unit or provider reference; this helper never manufactures one from
 * the legacy lookup label.
 */
export function collectIrDirectCallLoweringPlans(
  root: ts.Node,
  ownerUnitId: IrUnitId,
  targetsByLegacyName: ReadonlyMap<string, IrDirectCallTarget>,
): ReadonlyMap<ts.CallExpression, IrDirectCallLoweringPlan> {
  const plans = new Map<ts.CallExpression, IrDirectCallLoweringPlan>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const certified = targetsByLegacyName.get(node.expression.text);
      if (certified) {
        plans.set(node, {
          ownerUnitId,
          target: certified.target,
          signature: certified.signature,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
  return plans;
}

export interface IrHostVoidCallbackLoweringPlan {
  readonly ownerUnitId: IrUnitId;
  readonly ownerName: string;
  readonly signature: IrClosureSignature;
  readonly captureNames: ReadonlySet<string>;
  /** Exact source-order lift ordinal collision-proved before integration. */
  readonly liftedOrdinal: number;
}

/** One module binding's legacy storage, optionally tied to an exact terminal owner. */
export interface ModuleBindingGlobal {
  readonly ownerUnitId?: IrUnitId;
  readonly globalName: string;
  readonly tdzGlobalName: string | null;
  readonly type: IrType;
}

export interface IrIntegrationLoweringPlans {
  readonly identityContext: IrPlanningIdentityContext;
  /** Exact active terminal owners behind the remaining name-keyed integration API. */
  readonly ownerProjection: IrLegacyUnitProjection;
  readonly ownerUnitIdByLegacyName: ReadonlyMap<string, IrUnitId>;
  readonly signaturesByUnitId: ReadonlyMap<IrUnitId, IrClosureSignature>;
  readonly directCalls: ReadonlyMap<ts.CallExpression, IrDirectCallLoweringPlan>;
  readonly importedCalls: ReadonlyMap<ts.CallExpression, IrImportedCallLoweringPlan>;
  readonly topLevelFunctionValues: ReadonlyMap<ts.Identifier, IrTopLevelFunctionValueLoweringPlan>;
  readonly hostVoidCallbacks: ReadonlyMap<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan>;
  readonly promiseDelays: IrPromiseDelayLoweringPlans;
}

export function requireMatchingLoweringPlanOwner(
  planKind: "direct call" | "imported call" | "top-level function value" | "host void callback" | "module binding",
  planOwnerUnitId: IrUnitId,
  activeOwnerUnitId: IrUnitId | undefined,
  funcName: string,
): void {
  const ownerKind = planKind === "module binding" ? "structural module binding" : `${planKind} plan`;
  if (activeOwnerUnitId === undefined) {
    throw new Error(`ir/from-ast: ${ownerKind} cannot be consumed without an authoritative ownerUnitId (${funcName})`);
  }
  if (planOwnerUnitId !== activeOwnerUnitId) {
    const staleOwnerKind = planKind === "module binding" ? "module-binding" : `${planKind} plan`;
    throw new Error(
      `ir/from-ast: stale ${staleOwnerKind} owner ${planOwnerUnitId} does not match ${activeOwnerUnitId} (${funcName})`,
    );
  }
}

export function requireMatchingModuleBindingOwner(
  binding: ModuleBindingGlobal,
  activeOwnerUnitId: IrUnitId | undefined,
  funcName: string,
): void {
  if (binding.ownerUnitId !== undefined) {
    requireMatchingLoweringPlanOwner("module binding", binding.ownerUnitId, activeOwnerUnitId, funcName);
  }
}
