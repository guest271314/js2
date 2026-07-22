// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import type { IrUnitId } from "../ir/identity.js";
import { IrInvariantError } from "../ir/outcomes.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import {
  buildIrUnitTypeMap,
  projectIrUnitTypeMapToLegacy,
  type IrUnitTypeMap,
  type TypeMap,
  type TypeMapEntry,
} from "../ir/propagate.js";
import {
  planIrCompilationByIdentity,
  projectIrSelectionToLegacy,
  type IrIdentitySelection,
  type IrIdentitySelectionOptions,
  type IrLegacySelectionProjection,
} from "../ir/select-identity.js";

export interface IrOverlayIdentityFunctionClaim {
  readonly unitId: IrUnitId;
  readonly legacyName: string;
  readonly declaration: ts.FunctionDeclaration;
  readonly typeEntry: TypeMapEntry;
}

export interface IrOverlayIdentityPlan {
  readonly identityContext: IrPlanningIdentityContext;
  readonly identitySelection: IrIdentitySelection;
  readonly selectionProjection: IrLegacySelectionProjection;
  readonly functionClaims: readonly IrOverlayIdentityFunctionClaim[];
  readonly functionUnitIdByLegacyName: ReadonlyMap<string, IrUnitId>;
  readonly declarationByLegacyName: ReadonlyMap<string, ts.FunctionDeclaration>;
  readonly safeFunctionUnitIds: Set<IrUnitId>;
}

export interface IrOverlayIdentityMaps {
  readonly unitTypeMap: IrUnitTypeMap;
  readonly projectedTypeMap: TypeMap;
}

function mismatch(detail: string): never {
  throw new IrInvariantError("selection-preparation-mismatch", "resolve", detail);
}

export function buildIrOverlayIdentityMaps(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
  identityContext: IrPlanningIdentityContext,
): IrOverlayIdentityMaps {
  const unitTypeMap = buildIrUnitTypeMap([sourceFile], checker, identityContext);
  const projectedTypeMap = projectIrUnitTypeMapToLegacy([sourceFile], unitTypeMap, identityContext);
  return { unitTypeMap, projectedTypeMap };
}

/**
 * Cross the legacy name seam only through conservative projections. Every
 * executable claim keeps its exact declaration and TypeMap row; colliding
 * names never enter the preparation population.
 */
export function planIrOverlayByIdentity(
  sourceFile: ts.SourceFile,
  identityContext: IrPlanningIdentityContext,
  options: IrIdentitySelectionOptions,
  maps: IrOverlayIdentityMaps,
): IrOverlayIdentityPlan {
  const identitySelection = planIrCompilationByIdentity(sourceFile, identityContext, options, maps.unitTypeMap);
  const selectionProjection = projectIrSelectionToLegacy(identitySelection);
  const functionClaims: IrOverlayIdentityFunctionClaim[] = [];
  const functionUnitIdByLegacyName = new Map<string, IrUnitId>();
  const declarationByLegacyName = new Map<string, ts.FunctionDeclaration>();

  for (const [unitId, claim] of identitySelection.funcs) {
    if (selectionProjection.omittedUnitIds.has(unitId)) continue;
    const legacyName = claim.legacyMatchName;
    const declaration = identityContext.declarationByUnitId.get(unitId);
    const typeEntry = maps.unitTypeMap.get(unitId);
    if (
      !selectionProjection.selection.funcs.has(legacyName) ||
      !declaration ||
      !ts.isFunctionDeclaration(declaration) ||
      declaration.parent !== sourceFile ||
      declaration.name?.text !== legacyName ||
      !declaration.body ||
      !typeEntry ||
      maps.projectedTypeMap.get(legacyName) !== typeEntry ||
      functionUnitIdByLegacyName.has(legacyName)
    ) {
      mismatch(`structural IR selection ${unitId} has no unique exact legacy projection in ${sourceFile.fileName}`);
    }
    functionClaims.push({ unitId, legacyName, declaration, typeEntry });
    functionUnitIdByLegacyName.set(legacyName, unitId);
    declarationByLegacyName.set(legacyName, declaration);
  }

  return {
    identityContext,
    identitySelection,
    selectionProjection,
    functionClaims,
    functionUnitIdByLegacyName,
    declarationByLegacyName,
    safeFunctionUnitIds: new Set(),
  };
}

/** Project already-validated safe IDs to the remaining name-keyed backend. */
export function projectIrSafeFunctionNames(
  safeUnitIds: ReadonlySet<IrUnitId>,
  identityPlan: Pick<IrOverlayIdentityPlan, "identitySelection" | "selectionProjection">,
): Set<string> {
  const names = new Set<string>();
  for (const unitId of safeUnitIds) {
    const claim = identityPlan.identitySelection.funcs.get(unitId);
    if (
      !claim ||
      identityPlan.selectionProjection.omittedUnitIds.has(unitId) ||
      !identityPlan.selectionProjection.selection.funcs.has(claim.legacyMatchName) ||
      names.has(claim.legacyMatchName)
    ) {
      mismatch(`safe structural IR function ${unitId} has no unique retained legacy projection`);
    }
    names.add(claim.legacyMatchName);
  }
  return names;
}

/** Remove a projected owner while keeping the exact safe-ID population aligned. */
export function dropIrSafeFunctionByLegacyName(identityPlan: IrOverlayIdentityPlan, legacyName: string): void {
  const unitId = identityPlan.functionUnitIdByLegacyName.get(legacyName);
  if (!unitId || !identityPlan.safeFunctionUnitIds.delete(unitId)) {
    mismatch(`IR preparation owner ${legacyName} has no retained structural unit identity`);
  }
}
