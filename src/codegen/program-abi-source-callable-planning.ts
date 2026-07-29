// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irUnitCallableBindingId, irUnitFuncRef } from "../ir/callable-bindings.js";
import type { IrUnitId } from "../ir/identity.js";
import type { IrPlanningIdentityContext } from "../ir/planning-identity.js";
import { ProgramAbiInvariantError } from "../ir/program-abi.js";
import type { FuncHandle, FuncTypeDef, WasmFunction } from "../ir/types.js";
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";
import { definedFuncAt, pushDefinedFunc } from "./func-space.js";
import { planProgramAbiUnitCallable } from "./program-abi-planning.js";
import type { ProgramAbiSession } from "./program-abi-session.js";

interface SourceCallableObservation {
  readonly unitId: IrUnitId;
  readonly displayName: string;
  readonly funcIdx: FuncHandle;
}

/** Push and structurally observe one top-level source function atomically. */
export function pushProgramAbiTopLevelCallable(
  ctx: CodegenContext,
  declaration: ts.FunctionDeclaration,
  funcIdx: FuncHandle,
  func: WasmFunction,
): void {
  pushDefinedFunc(ctx, funcIdx, func);
  const registry = ctx.programAbiSourceCallables;
  if (!registry) {
    throw new ProgramAbiInvariantError(
      "context-session-mismatch",
      "top-level source callable was allocated without its structural registry",
    );
  }
  registry.observe(declaration, funcIdx);
}

function functionSignature(ctx: CodegenContext, func: WasmFunction): FuncTypeDef {
  const signature = ctx.mod.types[func.typeIdx];
  if (!signature || signature.kind !== "func") {
    throw new ProgramAbiInvariantError(
      "type-remap-mismatch",
      `source callable ${func.name} references non-function or missing type ${func.typeIdx}`,
    );
  }
  return signature;
}

/**
 * Exact allocator sidecar for top-level source function declarations.
 *
 * The sidecar exists without a Program ABI session so IR integration never
 * needs to recover a source slot from funcMap. With an identity inventory,
 * every retained direct or IR-replaced allocator receives its exact source
 * unit owner before generic final function-space population.
 */
export class ProgramAbiSourceCallableRegistry {
  private readonly observations = new Map<IrUnitId, SourceCallableObservation[]>();
  private planned = false;

  constructor(
    readonly ctx: CodegenContext,
    readonly session?: ProgramAbiSession,
    readonly identityContext?: IrPlanningIdentityContext,
  ) {
    session?.assertModule(ctx.mod);
    if (!session && identityContext) {
      throw new ProgramAbiInvariantError(
        "context-session-mismatch",
        "source-callable registry cannot accept a planning identity context without a Program ABI session",
      );
    }
    if (session && identityContext && identityContext.inventory !== session.inventory) {
      throw new ProgramAbiInvariantError(
        "context-session-mismatch",
        "source-callable registry and planning context do not share one inventory",
      );
    }
  }

  observe(declaration: ts.FunctionDeclaration, funcIdx: FuncHandle): IrUnitId | undefined {
    if (this.planned) {
      throw new ProgramAbiInvariantError(
        "planning-sealed",
        "cannot observe a source callable after retained source-callable planning",
      );
    }
    const func = definedFuncAt(this.ctx, funcIdx);
    if (!func) {
      throw new ProgramAbiInvariantError(
        "missing-required-locator",
        `source callable has no exact defined function for handle ${funcIdx}`,
      );
    }
    const identityContext = this.identityContext;
    if (!identityContext) return undefined;

    const unitId = identityContext.unitIdByDeclaration.get(declaration);
    const unit = unitId === undefined ? undefined : identityContext.unitByUnitId.get(unitId);
    const supportedUnit =
      unit?.kind === "top-level-function" || (unit?.kind === "synthetic-support" && unit.syntheticRole !== undefined);
    if (
      unitId === undefined ||
      !unit ||
      !supportedUnit ||
      identityContext.declarationByUnitId.get(unitId) !== declaration
    ) {
      throw new ProgramAbiInvariantError(
        "missing-source-unit",
        `source callable ${func.name} has no consistent exact top-level or compiler-support inventory owner`,
      );
    }

    const observations = this.observations.get(unitId) ?? [];
    const previous = observations.at(-1);
    if (previous?.funcIdx !== funcIdx || previous.displayName !== func.name) {
      observations.push(Object.freeze({ unitId, displayName: func.name, funcIdx }));
      this.observations.set(unitId, observations);
    }
    return unitId;
  }

  functionForUnit(unitId: IrUnitId): WasmFunction | undefined {
    const observation = this.observations.get(unitId)?.at(-1);
    return observation ? definedFuncAt(this.ctx, observation.funcIdx) : undefined;
  }

  handleForUnit(unitId: IrUnitId): FuncHandle | undefined {
    const observation = this.observations.get(unitId)?.at(-1);
    return observation && definedFuncAt(this.ctx, observation.funcIdx) ? observation.funcIdx : undefined;
  }

  /** Assign exact source-unit owners before generic retained callable planning. */
  planRetained(): void {
    if (this.planned) return;
    this.planned = true;
    const { session, identityContext } = this;
    if (!session || !identityContext) return;

    for (const [unitId, observations] of this.observations) {
      const canonical = observations
        .map((observation) => ({ observation, func: definedFuncAt(this.ctx, observation.funcIdx) }))
        .filter((entry): entry is { observation: SourceCallableObservation; func: WasmFunction } => !!entry.func)
        .at(-1);
      if (!canonical) continue;

      const expectedBindingId = irUnitCallableBindingId(unitId);
      if (session.hasPlan(expectedBindingId)) {
        if (!session.hasLocator(expectedBindingId, canonical.func)) {
          throw new ProgramAbiInvariantError(
            "duplicate-slot-locator",
            `retained source callable ${canonical.observation.displayName} is not the exact allocator owned by ${expectedBindingId}`,
          );
        }
        continue;
      }
      const bindingId = planProgramAbiUnitCallable(this.ctx, {
        ref: irUnitFuncRef({ unitId, name: canonical.observation.displayName }),
        signature: functionSignature(this.ctx, canonical.func),
        func: canonical.func,
      });
      if (bindingId !== expectedBindingId) {
        throw new ProgramAbiInvariantError(
          "missing-source-unit",
          `retained source callable ${canonical.observation.displayName} was not accepted for exact unit ${unitId}`,
        );
      }
    }
  }
}
