// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId, IrUnitId, IrTerminalUnitRecord } from "./identity.js";
import {
  createValidatedPreparedIrProgram,
  freezePreparedIrValue,
  preparedIrReadonlyMap,
  PreparedIrProgramInvariantError,
  type PreparedIrAllocationRecord,
  type PreparedIrBackendLegalityProof,
  type PreparedIrComponent,
  type PreparedIrInvariantUnit,
  type PreparedIrOptimizationEvidence,
  type PreparedIrPreparedUnit,
  type PreparedIrProgram,
  type PreparedIrProvenanceRecord,
  type PreparedIrSupportIntent,
  type PreparedIrUnitOutcome,
  type PreparedIrUnsupportedUnit,
} from "./program.js";
import type { ProgramAbiCallableSignature } from "./program-abi.js";
import { ProgramAbiMap } from "./program-abi.js";

export interface PreparedIrPreparedInput {
  readonly unitId: IrUnitId;
  readonly finalSignature: ProgramAbiCallableSignature;
  readonly exportIntents?: readonly IrBindingId[];
  readonly backendLegality: PreparedIrBackendLegalityProof;
  readonly optimization: PreparedIrOptimizationEvidence;
  readonly ir: unknown;
}

export interface PreparedIrFailureInput {
  readonly unitId: IrUnitId;
  readonly code: string;
  readonly stage: string;
  readonly detail: string;
}

export interface PreparedIrComponentInput {
  readonly id: string;
  readonly unitIds: readonly IrUnitId[];
}

type BuilderState = "open" | "sealing" | "sealed" | "failed";

function freezeSignature(signature: ProgramAbiCallableSignature): ProgramAbiCallableSignature {
  return Object.freeze({
    params: Object.freeze([...signature.params]),
    results: Object.freeze([...signature.results]),
  });
}

function freezePrepared(input: PreparedIrPreparedInput, unit: IrTerminalUnitRecord): PreparedIrPreparedUnit {
  return Object.freeze({
    kind: "prepared" as const,
    unitId: input.unitId,
    location: Object.freeze({
      sourceId: unit.sourceId,
      line: unit.line,
      column: unit.column,
      declarationStart: unit.declarationStart,
      declarationEnd: unit.declarationEnd,
    }),
    finalSignature: freezeSignature(input.finalSignature),
    exportIntents: Object.freeze([...(input.exportIntents ?? [])]),
    backendLegality: Object.freeze({ ...input.backendLegality }),
    optimization: Object.freeze({ ...input.optimization }),
    ir: freezePreparedIrValue(input.ir),
  });
}

function freezeFailure(
  kind: "unsupported" | "invariant",
  input: PreparedIrFailureInput,
): PreparedIrUnsupportedUnit | PreparedIrInvariantUnit {
  return Object.freeze({ kind, ...input });
}

function duplicateIds(ids: readonly IrUnitId[]): IrUnitId[] {
  const seen = new Set<IrUnitId>();
  const duplicates = new Set<IrUnitId>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates];
}

/**
 * Mutable preparation transaction. seal() validates the complete denominator
 * and publishes one immutable PreparedIrProgram snapshot or fails closed.
 */
export class PreparedIrProgramBuilder {
  readonly #abi: ProgramAbiMap;
  readonly #freeUnits: ReadonlyMap<IrUnitId, IrTerminalUnitRecord>;
  readonly #outcomes: PreparedIrUnitOutcome[] = [];
  readonly #components: PreparedIrComponentInput[] = [];
  readonly #supportIntents: PreparedIrSupportIntent[] = [];
  readonly #allocations: PreparedIrAllocationRecord[] = [];
  readonly #provenance: PreparedIrProvenanceRecord[] = [];
  #state: BuilderState = "open";
  #program?: PreparedIrProgram;

  constructor(abi: ProgramAbiMap) {
    if (!abi.planningSealed) {
      throw new PreparedIrProgramInvariantError(
        "abi-not-sealed",
        "PreparedIrProgram requires a sealed ProgramAbiMap plan",
      );
    }
    this.#abi = abi;
    this.#freeUnits = preparedIrReadonlyMap(
      abi.inventory.terminalUnits
        .filter((unit) => unit.kind === "top-level-function")
        .map((unit) => [unit.id, unit] as const),
    );
  }

  recordPrepared(input: PreparedIrPreparedInput): void {
    this.#assertOpen();
    const unit = this.#requireFreeUnit(input.unitId);
    if (
      input.backendLegality.verified !== true ||
      input.optimization.allocationProvenance !== "verified" ||
      !Array.isArray(input.finalSignature.params) ||
      !Array.isArray(input.finalSignature.results)
    ) {
      throw new PreparedIrProgramInvariantError(
        "invalid-prepared-evidence",
        `Prepared unit ${input.unitId} lacks final legality/optimization/signature evidence`,
      );
    }
    this.#outcomes.push(freezePrepared(input, unit));
  }

  recordUnsupported(input: PreparedIrFailureInput): void {
    this.#assertOpen();
    this.#requireFreeUnit(input.unitId);
    this.#outcomes.push(freezeFailure("unsupported", input));
  }

  recordInvariant(input: PreparedIrFailureInput): void {
    this.#assertOpen();
    this.#requireFreeUnit(input.unitId);
    this.#outcomes.push(freezeFailure("invariant", input));
  }

  addComponent(input: PreparedIrComponentInput): void {
    this.#assertOpen();
    this.#components.push(
      Object.freeze({
        id: input.id,
        unitIds: Object.freeze([...input.unitIds]),
      }),
    );
  }

  addSupportIntent(input: PreparedIrSupportIntent): void {
    if (this.#state !== "open") {
      throw new PreparedIrProgramInvariantError(
        "late-support-intent",
        `support intent ${input.key} was requested after preparation sealed`,
      );
    }
    this.#supportIntents.push(Object.freeze({ ...input }));
  }

  addAllocation(input: PreparedIrAllocationRecord): void {
    this.#assertOpen();
    this.#allocations.push(Object.freeze({ ...input }));
  }

  addProvenance(input: PreparedIrProvenanceRecord): void {
    this.#assertOpen();
    this.#provenance.push(Object.freeze({ ...input }));
  }

  seal(): PreparedIrProgram {
    if (this.#state === "sealed") return this.#program!;
    this.#assertOpen();
    this.#state = "sealing";
    try {
      const outcomeMap = this.#validateOutcomes();
      const components = this.#validateComponents(outcomeMap);
      this.#validateSupportIntents();
      this.#validatePreparedOwnership(outcomeMap);

      const prepared = [...outcomeMap].filter(
        (entry): entry is [IrUnitId, PreparedIrPreparedUnit] => entry[1].kind === "prepared",
      );
      const direct = [...outcomeMap].filter(
        (entry): entry is [IrUnitId, PreparedIrUnsupportedUnit] => entry[1].kind === "unsupported",
      );
      const invariant = [...outcomeMap].filter(
        (entry): entry is [IrUnitId, PreparedIrInvariantUnit] => entry[1].kind === "invariant",
      );
      this.#program = createValidatedPreparedIrProgram({
        abiEntries: this.#abi.entries(),
        units: preparedIrReadonlyMap(outcomeMap),
        preparedUnits: preparedIrReadonlyMap(prepared),
        directUnits: preparedIrReadonlyMap(direct),
        invariantUnits: preparedIrReadonlyMap(invariant),
        components,
        supportIntents: Object.freeze([...this.#supportIntents]),
        allocations: Object.freeze([...this.#allocations]),
        provenance: Object.freeze([...this.#provenance]),
      });
      this.#state = "sealed";
      return this.#program;
    } catch (error) {
      this.#state = "failed";
      throw error;
    }
  }

  #validateOutcomes(): Map<IrUnitId, PreparedIrUnitOutcome> {
    const duplicateOutcomes = duplicateIds(this.#outcomes.map((outcome) => outcome.unitId));
    if (duplicateOutcomes.length > 0) {
      throw new PreparedIrProgramInvariantError(
        "duplicate-unit",
        `free-function outcomes duplicated: ${duplicateOutcomes.join(", ")}`,
      );
    }
    const outcomes = new Map(this.#outcomes.map((outcome) => [outcome.unitId, outcome] as const));
    const unknown = [...outcomes.keys()].filter((unitId) => !this.#freeUnits.has(unitId));
    if (unknown.length > 0) {
      throw new PreparedIrProgramInvariantError("unknown-unit", `outcomes include non-R2 units: ${unknown.join(", ")}`);
    }
    const missing = [...this.#freeUnits.keys()].filter((unitId) => !outcomes.has(unitId));
    if (missing.length > 0) {
      throw new PreparedIrProgramInvariantError(
        "missing-unit",
        `free-function outcomes missing: ${missing.join(", ")}`,
      );
    }
    return outcomes;
  }

  #validateComponents(outcomes: ReadonlyMap<IrUnitId, PreparedIrUnitOutcome>): readonly PreparedIrComponent[] {
    const componentIds = this.#components.map((component) => component.id);
    if (new Set(componentIds).size !== componentIds.length) {
      throw new PreparedIrProgramInvariantError("duplicate-component", "component IDs must be unique");
    }
    const allMembers = this.#components.flatMap((component) => [...component.unitIds]);
    const duplicateMembers = duplicateIds(allMembers);
    if (duplicateMembers.length > 0) {
      throw new PreparedIrProgramInvariantError(
        "duplicate-component-unit",
        `free functions belong to multiple components: ${duplicateMembers.join(", ")}`,
      );
    }
    const unknownMembers = allMembers.filter((unitId) => !this.#freeUnits.has(unitId));
    if (unknownMembers.length > 0) {
      throw new PreparedIrProgramInvariantError(
        "unknown-unit",
        `components include non-R2 units: ${unknownMembers.join(", ")}`,
      );
    }
    const missingMembers = [...this.#freeUnits.keys()].filter((unitId) => !allMembers.includes(unitId));
    if (missingMembers.length > 0) {
      throw new PreparedIrProgramInvariantError(
        "missing-component-unit",
        `free functions lack component ownership: ${missingMembers.join(", ")}`,
      );
    }
    return Object.freeze(
      this.#components.map((component) => {
        if (component.unitIds.length === 0) {
          throw new PreparedIrProgramInvariantError("empty-component", `component ${component.id} is empty`);
        }
        const kinds = new Set(component.unitIds.map((unitId) => outcomes.get(unitId)!.kind));
        if (kinds.size !== 1) {
          throw new PreparedIrProgramInvariantError(
            "mixed-component-outcome",
            `component ${component.id} mixes terminal outcomes: ${[...kinds].join(", ")}`,
          );
        }
        return Object.freeze({
          id: component.id,
          unitIds: Object.freeze([...component.unitIds]),
          outcome: [...kinds][0]!,
        });
      }),
    );
  }

  #validateSupportIntents(): void {
    const keys = this.#supportIntents.map((intent) => intent.key);
    if (new Set(keys).size !== keys.length) {
      throw new PreparedIrProgramInvariantError("duplicate-support-intent", "support intent keys must be unique");
    }
    for (const intent of this.#supportIntents) {
      if (intent.ownerUnitId && !this.#freeUnits.has(intent.ownerUnitId)) {
        throw new PreparedIrProgramInvariantError(
          "unknown-support-owner",
          `support intent ${intent.key} has unknown owner ${intent.ownerUnitId}`,
        );
      }
      if (intent.bindingId && !this.#abi.get(intent.bindingId)) {
        throw new PreparedIrProgramInvariantError(
          "unknown-support-binding",
          `support intent ${intent.key} references unplanned binding ${intent.bindingId}`,
        );
      }
    }
  }

  #validatePreparedOwnership(outcomes: ReadonlyMap<IrUnitId, PreparedIrUnitOutcome>): void {
    const allocationKeys = this.#allocations.map((record) => record.key);
    if (new Set(allocationKeys).size !== allocationKeys.length) {
      throw new PreparedIrProgramInvariantError("duplicate-allocation", "allocation keys must be unique");
    }
    for (const record of this.#allocations) {
      if (outcomes.get(record.ownerUnitId)?.kind !== "prepared") {
        throw new PreparedIrProgramInvariantError(
          "allocation-not-prepared-owned",
          `allocation ${record.key} is owned by non-Prepared unit ${record.ownerUnitId}`,
        );
      }
    }
    const artifactIds = this.#provenance.map((record) => record.artifactUnitId);
    if (new Set(artifactIds).size !== artifactIds.length) {
      throw new PreparedIrProgramInvariantError("duplicate-provenance", "artifact provenance must be unique");
    }
    for (const record of this.#provenance) {
      if (outcomes.get(record.ownerUnitId)?.kind !== "prepared") {
        throw new PreparedIrProgramInvariantError(
          "provenance-not-prepared-owned",
          `artifact ${record.artifactUnitId} is owned by non-Prepared unit ${record.ownerUnitId}`,
        );
      }
    }
  }

  #requireFreeUnit(unitId: IrUnitId): IrTerminalUnitRecord {
    const unit = this.#freeUnits.get(unitId);
    if (!unit) {
      throw new PreparedIrProgramInvariantError(
        "unknown-unit",
        `${unitId} is not an inventoried top-level free function`,
      );
    }
    return unit;
  }

  #assertOpen(): void {
    if (this.#state === "failed") {
      throw new PreparedIrProgramInvariantError("program-seal-failed", "preparation transaction already failed");
    }
    if (this.#state !== "open") {
      throw new PreparedIrProgramInvariantError("program-sealed", `preparation transaction is ${this.#state}`);
    }
  }
}
