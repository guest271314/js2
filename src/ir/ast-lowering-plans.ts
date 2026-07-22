// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrUnitId } from "./identity.js";
import type { IrClosureSignature, IrType } from "./nodes.js";
import type { IrLegacyUnitProjection, IrPlanningIdentityContext } from "./planning-identity.js";
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
  readonly importedCalls: ReadonlyMap<ts.CallExpression, IrImportedCallLoweringPlan>;
  readonly topLevelFunctionValues: ReadonlyMap<ts.Identifier, IrTopLevelFunctionValueLoweringPlan>;
  readonly hostVoidCallbacks: ReadonlyMap<ts.ArrowFunction, IrHostVoidCallbackLoweringPlan>;
  readonly promiseDelays: IrPromiseDelayLoweringPlans;
}

export function requireMatchingLoweringPlanOwner(
  planKind: "imported call" | "top-level function value" | "host void callback" | "module binding",
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
