// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irGlobalBindingKey } from "../ir/abi-bindings.js";
import { irCallableBindingKey, irUnitCallableBindingId } from "../ir/callable-bindings.js";
import { createIrBindingId, type IrBindingId, type IrClassId, type IrSourceId, type IrUnitId } from "../ir/identity.js";
import type { IrFuncRef, IrGlobalRef } from "../ir/nodes.js";
import type { FuncTypeDef, GlobalDef, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import {
  canonicalProgramAbiCallableTypeContract,
  canonicalProgramAbiValType,
  cloneProgramAbiCallableTypeContract,
} from "./program-abi-signatures.js";

export const PROGRAM_ABI_CALLABLE_ROLE = Object.freeze({
  body: 0,
  functionValueTrampoline: 1,
  classConstructorInit: 2,
} as const);

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

export interface ProgramAbiUnitCallablePlan {
  readonly ref: IrFuncRef;
  readonly signature: FuncTypeDef;
  readonly func: WasmFunction;
}

export interface ProgramAbiSupportCallablePlan {
  readonly ref: IrFuncRef;
  readonly anchor:
    | { readonly kind: "unit"; readonly unitId: IrUnitId }
    | { readonly kind: "class"; readonly classId: IrClassId };
  readonly role: string;
  readonly roleOrdinal: number;
  readonly signature: FuncTypeDef;
  readonly func: WasmFunction;
}

export interface ProgramAbiFunctionValuePlan {
  readonly trampoline: IrFuncRef;
  readonly cacheGlobal: IrGlobalRef;
  readonly target: IrFuncRef;
}

/**
 * Plan and locate one exact unit-owned function body.
 *
 * The compatibility name is diagnostic only. Both the ABI identity and the
 * resolver payload derive from the structural unit ID, while the signature
 * preserves every ValType index and semantic brand used by function typing.
 */
export function planProgramAbiUnitCallable(
  ctx: CodegenContext,
  plan: ProgramAbiUnitCallablePlan,
): IrBindingId | undefined {
  const session = ctx.programAbiSession;
  if (!session) return undefined;
  if (plan.ref.binding.kind !== "unit") {
    throw new TypeError("program ABI unit callable planning requires an exact unit reference");
  }
  const unitId = plan.ref.binding.unitId;
  if (!session.hasKnownUnit(unitId)) return undefined;
  const derived = session.registeredDerivedUnit(unitId);
  if (derived && derived.role !== "lifted-closure" && derived.role !== "monomorphization-clone") {
    return undefined;
  }
  const bindingId = irUnitCallableBindingId(unitId);
  const structuralReferenceKey = irCallableBindingKey(plan.ref.binding);
  const typeContract = cloneProgramAbiCallableTypeContract(plan.signature);
  session.ensurePlan({
    id: bindingId,
    structuralOrder: session.structuralOrder.forUnit(unitId, {
      domain: "callable",
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.body,
    }),
    structuralReferenceKey,
    displayName: plan.func.name,
    slotPolicy: "required",
    slotSpace: "function",
    intent: {
      kind: "callable",
      origin: "source",
      unitId,
      signature: canonicalProgramAbiCallableTypeContract(typeContract),
    },
  });
  session.registerCallableTypeContract(bindingId, typeContract);
  session.registerStructuralReference(bindingId, structuralReferenceKey);
  if (!session.hasLocator(bindingId, plan.func)) {
    session.attachLocator(bindingId, { kind: "defined-function", value: plan.func });
  }
  return bindingId;
}

/**
 * Plan and locate one compiler-owned support callable beneath an exact
 * inventoried unit or class.
 *
 * The explicit structural anchor supplies deterministic whole-program order and
 * provenance without parsing the opaque support binding ID. The support
 * reference supplies identity; its compatibility label cannot redirect the
 * exact allocator-owned function locator.
 */
export function planProgramAbiSupportCallable(
  ctx: CodegenContext,
  plan: ProgramAbiSupportCallablePlan,
): IrBindingId | undefined {
  const session = ctx.programAbiSession;
  if (!session) return undefined;
  if (plan.ref.binding.kind !== "support") {
    throw new TypeError("program ABI support callable planning requires an exact support reference");
  }
  const ownerId = plan.anchor.kind === "unit" ? plan.anchor.unitId : plan.anchor.classId;
  const expectedBindingId = createIrBindingId({
    ownerId,
    domain: "support",
    role: plan.role,
  });
  if (plan.ref.binding.bindingId !== expectedBindingId) {
    throw new TypeError(
      `program ABI support callable reference does not match ${plan.anchor.kind} anchor ${ownerId} and role ${plan.role}`,
    );
  }
  const bindingId = plan.ref.binding.bindingId;
  const structuralReferenceKey = irCallableBindingKey(plan.ref.binding);
  const typeContract = cloneProgramAbiCallableTypeContract(plan.signature);
  const structuralOrder =
    plan.anchor.kind === "unit"
      ? session.structuralOrder.forUnit(plan.anchor.unitId, {
          domain: "callable",
          roleOrdinal: plan.roleOrdinal,
        })
      : session.structuralOrder.forClass(plan.anchor.classId, {
          domain: "callable",
          roleOrdinal: plan.roleOrdinal,
        });
  const provenance = plan.anchor.kind === "unit" ? { unitId: plan.anchor.unitId } : { classId: plan.anchor.classId };
  session.ensurePlan({
    id: bindingId,
    structuralOrder,
    structuralReferenceKey,
    displayName: plan.func.name,
    slotPolicy: "required",
    slotSpace: "function",
    intent: {
      kind: "callable",
      origin: "support",
      ...provenance,
      signature: canonicalProgramAbiCallableTypeContract(typeContract),
    },
  });
  session.registerCallableTypeContract(bindingId, typeContract);
  session.registerStructuralReference(bindingId, structuralReferenceKey);
  if (!session.hasLocator(bindingId, plan.func)) {
    session.attachLocator(bindingId, { kind: "defined-function", value: plan.func });
  }
  return bindingId;
}

/** Publish the exact cached function-value singleton as one ABI-owned pair. */
export function planProgramAbiFunctionValue(
  ctx: CodegenContext,
  plan: ProgramAbiFunctionValuePlan,
  func: WasmFunction,
  global: GlobalDef,
): boolean {
  const signature = ctx.mod.types[func.typeIdx];
  if (
    plan.target.binding.kind !== "unit" ||
    func.name !== plan.trampoline.name ||
    global.name !== plan.cacheGlobal.name ||
    !signature ||
    signature.kind !== "func"
  ) {
    return false;
  }
  planProgramAbiSupportCallable(ctx, {
    ref: plan.trampoline,
    anchor: { kind: "unit", unitId: plan.target.binding.unitId },
    role: "function-value-trampoline",
    roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.functionValueTrampoline,
    signature,
    func,
  });
  planProgramAbiGlobal(ctx, {
    ref: plan.cacheGlobal,
    anchor: { kind: "unit", unitId: plan.target.binding.unitId },
    roleOrdinal: PROGRAM_ABI_GLOBAL_ROLE.functionValueCache,
    global,
  });
  return true;
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
      valueType: canonicalProgramAbiValType(plan.global.type),
      mutable: plan.global.mutable,
    },
  });
  session.registerGlobalTypeContract(binding.bindingId, plan.global.type, plan.global.mutable);
  session.registerStructuralReference(binding.bindingId, structuralReferenceKey);
  if (!session.hasLocator(binding.bindingId, plan.global)) {
    session.attachLocator(binding.bindingId, { kind: "defined-global", value: plan.global });
  }
}
