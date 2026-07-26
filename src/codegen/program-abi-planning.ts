// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irGlobalBindingKey } from "../ir/abi-bindings.js";
import type { IrSourceId, IrUnitId } from "../ir/identity.js";
import type { IrGlobalRef } from "../ir/nodes.js";
import type { GlobalDef } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

export const PROGRAM_ABI_GLOBAL_ROLE = Object.freeze({
  moduleValue: 0,
  moduleTdz: 1,
  functionValueCache: 2,
  argc: 3,
} as const);

export type ProgramAbiGlobalAnchor =
  | { readonly kind: "source"; readonly sourceId: IrSourceId }
  | { readonly kind: "unit"; readonly unitId: IrUnitId };

export interface ProgramAbiGlobalPlan {
  readonly ref: IrGlobalRef;
  readonly anchor: ProgramAbiGlobalAnchor;
  readonly roleOrdinal: number;
  readonly derivedOrdinal?: number;
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
  const structuralReferenceKey = irGlobalBindingKey(binding);
  const suborder = {
    domain: "global" as const,
    roleOrdinal: plan.roleOrdinal,
    derivedOrdinal: plan.derivedOrdinal,
  };
  const structuralOrder =
    plan.anchor.kind === "source"
      ? session.structuralOrder.forSource(plan.anchor.sourceId, suborder)
      : session.structuralOrder.forUnit(plan.anchor.unitId, suborder);
  session.ensurePlan({
    id: binding.bindingId,
    structuralOrder,
    structuralReferenceKey,
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
  session.registerStructuralReference(binding.bindingId, structuralReferenceKey);
  if (!session.hasLocator(binding.bindingId, plan.global)) {
    session.attachLocator(binding.bindingId, { kind: "defined-global", value: plan.global });
  }
}
