// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrSourceId, IrUnitId, IrUnitInventory } from "../ir/identity.js";
import { irGlobalBindingKey } from "../ir/abi-bindings.js";
import type { IrGlobalRef } from "../ir/nodes.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { GlobalDef } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { programAbiDomainOrdinal } from "./program-abi-session.js";

export const PROGRAM_ABI_GLOBAL_ROLE = Object.freeze({
  moduleValue: 0,
  moduleTdz: 1,
  functionValueCache: 2,
  argc: 3,
} as const);

function compareUnitOrder(
  left: IrUnitInventory["allUnits"][number],
  right: IrUnitInventory["allUnits"][number],
): number {
  return (
    left.declarationStart - right.declarationStart ||
    left.declarationEnd - right.declarationEnd ||
    (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0) ||
    left.ordinal - right.ordinal ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

/** Stable source-local declaration order for one exact inventory unit. */
export function programAbiUnitDeclarationOrdinal(inventory: IrUnitInventory, unitId: IrUnitId): number {
  const unit = inventory.allUnits.find((candidate) => candidate.id === unitId);
  if (!unit) {
    throw new ProgramAbiInvariantError("unknown-inventory-unit", `ABI global owner ${unitId} is outside the inventory`);
  }
  const ordered = inventory.allUnits.filter((candidate) => candidate.sourceId === unit.sourceId).sort(compareUnitOrder);
  const ordinal = ordered.findIndex((candidate) => candidate.id === unitId);
  if (ordinal < 0) {
    throw new ProgramAbiInvariantError("unknown-inventory-unit", `ABI global owner ${unitId} has no source order`);
  }
  return ordinal;
}

export function programAbiSourceIdForUnit(inventory: IrUnitInventory, unitId: IrUnitId): IrSourceId {
  const unit = inventory.allUnits.find((candidate) => candidate.id === unitId);
  if (!unit) {
    throw new ProgramAbiInvariantError("unknown-inventory-unit", `ABI global owner ${unitId} is outside the inventory`);
  }
  return unit.sourceId;
}

export interface ProgramAbiGlobalPlan {
  readonly ref: IrGlobalRef;
  readonly sourceId: IrSourceId;
  readonly declarationOrdinal: number;
  readonly roleOrdinal: number;
  readonly global: GlobalDef;
}

/**
 * Plan and locate one exact IR-visible global.
 *
 * Repeated references to the same binding are idempotent only when they point
 * at the same allocator-owned GlobalDef object.
 */
export function planProgramAbiGlobal(ctx: CodegenContext, plan: ProgramAbiGlobalPlan): void {
  const session = ctx.programAbiSession;
  if (!session) return;
  const { binding } = plan.ref;
  const origin = binding.kind === "source" ? "source" : binding.kind;
  if (!session.hasPlan(binding.bindingId)) {
    session.plan({
      id: binding.bindingId,
      structuralOrder: {
        sourceId: plan.sourceId,
        declarationOrdinal: plan.declarationOrdinal,
        domainOrdinal: programAbiDomainOrdinal("global"),
        roleOrdinal: plan.roleOrdinal,
        derivedOrdinal: 0,
      },
      displayName: plan.ref.name,
      slotPolicy: "required",
      slotSpace: "global",
      intent: {
        kind: "global",
        origin,
        valueType: JSON.stringify(plan.global.type),
        mutable: plan.global.mutable,
      },
    });
  }
  session.registerStructuralReference(binding.bindingId, irGlobalBindingKey(binding));
  if (!session.hasLocator(binding.bindingId, plan.global)) {
    session.attachLocator(binding.bindingId, { kind: "defined-global", value: plan.global });
  }
}
