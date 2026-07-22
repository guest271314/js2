// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrUnitId } from "./identity.js";
import type { IrClosureSignature, IrType } from "./nodes.js";
import type { IrPromiseDelayLoweringPlans } from "./promise-delay-lowering.js";
import type { ts } from "../ts-api.js";

export interface IrImportedOptionalParamPlan {
  readonly constantDefault?:
    | { readonly kind: "f64"; readonly value: number }
    | { readonly kind: "i32"; readonly value: number };
  readonly hasExpressionDefault?: boolean;
}

export interface IrImportedCallLoweringPlan {
  readonly ownerUnitId: IrUnitId;
  readonly ownerName: string;
  readonly targetUnitId: IrUnitId;
  readonly targetName: string;
  readonly params: readonly IrType[];
  readonly returnType: IrType | null;
  readonly optionalParams: ReadonlyMap<number, IrImportedOptionalParamPlan>;
  readonly needsArgc: boolean;
}

export interface IrTopLevelFunctionValueLoweringPlan {
  readonly ownerUnitId: IrUnitId;
  readonly ownerName: string;
  readonly targetUnitId: IrUnitId;
  readonly targetName: string;
  readonly signature: IrClosureSignature;
  readonly trampolineName: string;
  readonly cacheGlobalName: string;
}

export interface IrHostVoidCallbackLoweringPlan {
  readonly ownerUnitId: IrUnitId;
  readonly ownerName: string;
  readonly signature: IrClosureSignature;
  readonly captureNames: ReadonlySet<string>;
  /** Exact source-order lift ordinal collision-proved before integration. */
  readonly liftedOrdinal: number;
}

export interface IrIntegrationLoweringPlans {
  readonly ownerUnitIdByLegacyName: ReadonlyMap<string, IrUnitId>;
  readonly importedCalls: ReadonlyMap<ts.CallExpression, IrImportedCallLoweringPlan>;
  readonly topLevelFunctionValues: ReadonlyMap<ts.Identifier, IrTopLevelFunctionValueLoweringPlan>;
  readonly hostVoidCallbacks: ReadonlyMap<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan>;
  readonly promiseDelays: IrPromiseDelayLoweringPlans;
}

export function requireMatchingLoweringPlanOwner(
  planKind: "imported call" | "top-level function value" | "host void callback",
  planOwnerUnitId: IrUnitId,
  activeOwnerUnitId: IrUnitId | undefined,
  funcName: string,
): void {
  if (activeOwnerUnitId === undefined) {
    throw new Error(
      `ir/from-ast: ${planKind} plan cannot be consumed without an authoritative ownerUnitId (${funcName})`,
    );
  }
  if (planOwnerUnitId !== activeOwnerUnitId) {
    throw new Error(
      `ir/from-ast: stale ${planKind} plan owner ${planOwnerUnitId} does not match ${activeOwnerUnitId} (${funcName})`,
    );
  }
}
