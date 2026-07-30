// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBackendKind } from "./backend/legality.js";
import type { IrBindingId, IrSourceId, IrUnitId } from "./identity.js";
import type { ProgramAbiCallableSignature, ProgramAbiPlanEntry } from "./program-abi.js";

export type PreparedIrOutcomeKind = "prepared" | "unsupported" | "invariant";
export type PreparedIrEmitter = "direct" | "ir";

export type PreparedIrProgramInvariantCode =
  | "abi-not-sealed"
  | "program-sealed"
  | "program-seal-failed"
  | "duplicate-unit"
  | "missing-unit"
  | "unknown-unit"
  | "duplicate-component"
  | "empty-component"
  | "duplicate-component-unit"
  | "missing-component-unit"
  | "mixed-component-outcome"
  | "duplicate-support-intent"
  | "late-support-intent"
  | "unknown-support-owner"
  | "unknown-support-binding"
  | "duplicate-allocation"
  | "allocation-not-prepared-owned"
  | "duplicate-provenance"
  | "provenance-not-prepared-owned"
  | "invalid-prepared-evidence"
  | "program-has-invariant"
  | "emission-already-started"
  | "transaction-closed"
  | "wrong-emitter"
  | "duplicate-emission"
  | "unknown-emission-unit"
  | "partial-publication"
  | "emission-failed";

export class PreparedIrProgramInvariantError extends Error {
  constructor(
    readonly code: PreparedIrProgramInvariantCode,
    message: string,
  ) {
    super(message);
    this.name = "PreparedIrProgramInvariantError";
  }
}

export interface PreparedIrSourceLocation {
  readonly sourceId: IrSourceId;
  readonly line: number;
  readonly column: number;
  readonly declarationStart: number;
  readonly declarationEnd: number;
}

export interface PreparedIrOptimizationEvidence {
  readonly inlineSmall: "applied" | "not-applicable";
  readonly monomorphization: "applied" | "not-applicable";
  readonly allocationProvenance: "verified";
}

export interface PreparedIrBackendLegalityProof {
  readonly backend: IrBackendKind;
  readonly target: "gc" | "linear" | "standalone" | "wasi";
  readonly verified: true;
}

export interface PreparedIrPreparedUnit {
  readonly kind: "prepared";
  readonly unitId: IrUnitId;
  readonly location: PreparedIrSourceLocation;
  readonly finalSignature: ProgramAbiCallableSignature;
  readonly exportIntents: readonly IrBindingId[];
  readonly backendLegality: PreparedIrBackendLegalityProof;
  readonly optimization: PreparedIrOptimizationEvidence;
  /** Frozen post-pass typed IR. The structural slice deliberately does not emit it. */
  readonly ir: unknown;
}

export interface PreparedIrUnsupportedUnit {
  readonly kind: "unsupported";
  readonly unitId: IrUnitId;
  readonly code: string;
  readonly stage: string;
  readonly detail: string;
}

export interface PreparedIrInvariantUnit {
  readonly kind: "invariant";
  readonly unitId: IrUnitId;
  readonly code: string;
  readonly stage: string;
  readonly detail: string;
}

export type PreparedIrUnitOutcome = PreparedIrPreparedUnit | PreparedIrUnsupportedUnit | PreparedIrInvariantUnit;

export interface PreparedIrComponent {
  readonly id: string;
  readonly unitIds: readonly IrUnitId[];
  readonly outcome: PreparedIrOutcomeKind;
}

export type PreparedIrSupportIntentKind =
  | "import"
  | "global"
  | "type"
  | "literal"
  | "helper"
  | "lifted-closure"
  | "host-callback"
  | "runtime-entry"
  | "export"
  | "monomorphized-clone";

/** A symbolic request resolved during preparation, before either body emitter runs. */
export interface PreparedIrSupportIntent {
  readonly key: string;
  readonly kind: PreparedIrSupportIntentKind;
  readonly ownerUnitId?: IrUnitId;
  readonly bindingId?: IrBindingId;
  readonly detail?: string;
}

export type PreparedIrAllocationKind = "function" | "global" | "type" | "literal" | "helper";

/** Allocation reservation owned only by a Prepared unit; no concrete Wasm index is allocated here. */
export interface PreparedIrAllocationRecord {
  readonly key: string;
  readonly kind: PreparedIrAllocationKind;
  readonly ownerUnitId: IrUnitId;
  readonly bindingId?: IrBindingId;
  readonly ordinal: number;
}

export type PreparedIrProvenanceRole = "source" | "lifted-closure" | "monomorphization-clone";

/** Exact source/pass provenance for a Prepared-owned source or derived IR artifact. */
export interface PreparedIrProvenanceRecord {
  readonly artifactUnitId: IrUnitId;
  readonly ownerUnitId: IrUnitId;
  readonly role: PreparedIrProvenanceRole;
  readonly parentUnitId?: IrUnitId;
  readonly ordinal: number;
}

export interface PreparedIrAbiSnapshot {
  readonly planningSealed: true;
  readonly entries: readonly ProgramAbiPlanEntry[];
  get(id: IrBindingId): ProgramAbiPlanEntry | undefined;
}

export interface PreparedIrEmissionLedgerEntry {
  readonly unitId: IrUnitId;
  readonly outcome: PreparedIrOutcomeKind;
  readonly prepareAttempts: 1;
  readonly directBodyEmissions: number;
  readonly irBodyEmissions: number;
  readonly legacyBodyEmitted: boolean;
  readonly irBodyEmitted: boolean;
}

export interface PreparedIrStagedBody {
  readonly unitId: IrUnitId;
  readonly emitter: PreparedIrEmitter;
  readonly body: unknown;
}

export interface PreparedIrPublication {
  readonly bodies: ReadonlyMap<IrUnitId, PreparedIrStagedBody>;
  readonly ledger: ReadonlyMap<IrUnitId, PreparedIrEmissionLedgerEntry>;
}

export interface PreparedIrProgram {
  readonly abi: PreparedIrAbiSnapshot;
  /** Exact R2 denominator: all and only inventoried top-level free functions. */
  readonly units: ReadonlyMap<IrUnitId, PreparedIrUnitOutcome>;
  readonly preparedUnits: ReadonlyMap<IrUnitId, PreparedIrPreparedUnit>;
  readonly directUnits: ReadonlyMap<IrUnitId, PreparedIrUnsupportedUnit>;
  readonly invariantUnits: ReadonlyMap<IrUnitId, PreparedIrInvariantUnit>;
  readonly components: readonly PreparedIrComponent[];
  readonly supportIntents: readonly PreparedIrSupportIntent[];
  readonly allocations: readonly PreparedIrAllocationRecord[];
  readonly provenance: readonly PreparedIrProvenanceRecord[];
  readonly sealed: true;
  beginEmission(): PreparedIrEmissionTransaction;
}

class FrozenMap<K, V> implements ReadonlyMap<K, V> {
  readonly #map: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#map = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#map.size;
  }
  has(key: K): boolean {
    return this.#map.has(key);
  }
  get(key: K): V | undefined {
    return this.#map.get(key);
  }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#map) callbackfn.call(thisArg, value, key, this);
  }
  entries(): MapIterator<[K, V]> {
    return this.#map.entries();
  }
  keys(): MapIterator<K> {
    return this.#map.keys();
  }
  values(): MapIterator<V> {
    return this.#map.values();
  }
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#map[Symbol.iterator]();
  }
  get [Symbol.toStringTag](): string {
    return "FrozenMap";
  }
}

export function preparedIrReadonlyMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  return new FrozenMap(entries);
}

function immutableCopy(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) {
    throw new PreparedIrProgramInvariantError("invalid-prepared-evidence", "prepared evidence must be acyclic");
  }
  const nextAncestors = new Set(ancestors).add(value);
  if (Array.isArray(value)) return Object.freeze(value.map((item) => immutableCopy(item, nextAncestors)));
  if (value instanceof Map) {
    return preparedIrReadonlyMap(
      [...value].map(([key, item]) => [immutableCopy(key, nextAncestors), immutableCopy(item, nextAncestors)] as const),
    );
  }
  if (value instanceof Set) {
    return Object.freeze([...value].map((item) => immutableCopy(item, nextAncestors)));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new PreparedIrProgramInvariantError(
      "invalid-prepared-evidence",
      `prepared evidence contains unsupported mutable ${prototype?.constructor?.name ?? "object"}`,
    );
  }
  const copy: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    copy[key] = immutableCopy((value as Record<PropertyKey, unknown>)[key], nextAncestors);
  }
  return Object.freeze(copy);
}

export function freezePreparedIrValue(value: unknown): unknown {
  return immutableCopy(value);
}

interface MutableLedgerEntry {
  readonly unitId: IrUnitId;
  readonly outcome: PreparedIrOutcomeKind;
  directBodyEmissions: number;
  irBodyEmissions: number;
}

export class PreparedIrEmissionTransaction {
  readonly #program: PreparedIrProgram;
  readonly #staged = new Map<IrUnitId, PreparedIrStagedBody>();
  readonly #ledger = new Map<IrUnitId, MutableLedgerEntry>();
  #state: "open" | "published" | "aborted" = "open";
  #publication?: PreparedIrPublication;

  constructor(program: PreparedIrProgram) {
    this.#program = program;
    for (const [unitId, outcome] of program.units) {
      this.#ledger.set(unitId, {
        unitId,
        outcome: outcome.kind,
        directBodyEmissions: 0,
        irBodyEmissions: 0,
      });
    }
  }

  get publication(): PreparedIrPublication | undefined {
    return this.#publication;
  }

  get ledger(): ReadonlyMap<IrUnitId, PreparedIrEmissionLedgerEntry> {
    return this.#ledgerSnapshot();
  }

  emitIr(unitId: IrUnitId, body: unknown): void {
    this.#stage(unitId, "ir", body);
  }

  emitDirect(unitId: IrUnitId, body: unknown): void {
    this.#stage(unitId, "direct", body);
  }

  failEmission(unitId: IrUnitId, emitter: PreparedIrEmitter, detail: string): never {
    this.#assertOpen();
    this.#assertDirection(unitId, emitter);
    this.#state = "aborted";
    throw new PreparedIrProgramInvariantError("emission-failed", `${emitter} emission for ${unitId} failed: ${detail}`);
  }

  publish(): PreparedIrPublication {
    this.#assertOpen();
    const missing = [...this.#program.units].filter(([unitId, outcome]) => {
      if (outcome.kind === "invariant") return false;
      return !this.#staged.has(unitId);
    });
    if (missing.length > 0) {
      this.#state = "aborted";
      throw new PreparedIrProgramInvariantError(
        "partial-publication",
        `cannot publish ${this.#staged.size}/${this.#program.preparedUnits.size + this.#program.directUnits.size} bodies; missing ${missing
          .map(([unitId]) => unitId)
          .join(", ")}`,
      );
    }
    const publication = Object.freeze({
      bodies: preparedIrReadonlyMap(this.#staged),
      ledger: this.#ledgerSnapshot(),
    });
    this.#publication = publication;
    this.#state = "published";
    return publication;
  }

  #stage(unitId: IrUnitId, emitter: PreparedIrEmitter, body: unknown): void {
    this.#assertOpen();
    this.#assertDirection(unitId, emitter);
    if (this.#staged.has(unitId)) {
      this.#state = "aborted";
      throw new PreparedIrProgramInvariantError("duplicate-emission", `${unitId} was emitted more than once`);
    }
    const frozenBody = freezePreparedIrValue(body);
    const ledger = this.#ledger.get(unitId)!;
    if (emitter === "ir") ledger.irBodyEmissions = 1;
    else ledger.directBodyEmissions = 1;
    this.#staged.set(unitId, Object.freeze({ unitId, emitter, body: frozenBody }));
  }

  #assertDirection(unitId: IrUnitId, emitter: PreparedIrEmitter): void {
    const outcome = this.#program.units.get(unitId);
    if (!outcome) {
      this.#state = "aborted";
      throw new PreparedIrProgramInvariantError("unknown-emission-unit", `${unitId} is outside the prepared program`);
    }
    const expected = outcome.kind === "prepared" ? "ir" : outcome.kind === "unsupported" ? "direct" : "neither";
    if (emitter !== expected) {
      this.#state = "aborted";
      throw new PreparedIrProgramInvariantError(
        "wrong-emitter",
        `${unitId} is ${outcome.kind}; expected ${expected} emission, received ${emitter}`,
      );
    }
  }

  #assertOpen(): void {
    if (this.#state !== "open") {
      throw new PreparedIrProgramInvariantError("transaction-closed", `emission transaction is ${this.#state}`);
    }
  }

  #ledgerSnapshot(): ReadonlyMap<IrUnitId, PreparedIrEmissionLedgerEntry> {
    return preparedIrReadonlyMap(
      [...this.#ledger].map(([unitId, entry]) => {
        const frozen = Object.freeze({
          ...entry,
          prepareAttempts: 1 as const,
          legacyBodyEmitted: entry.directBodyEmissions === 1,
          irBodyEmitted: entry.irBodyEmissions === 1,
        });
        return [unitId, frozen] as const;
      }),
    );
  }
}

export interface ValidatedPreparedIrProgram {
  readonly abiEntries: readonly ProgramAbiPlanEntry[];
  readonly units: ReadonlyMap<IrUnitId, PreparedIrUnitOutcome>;
  readonly preparedUnits: ReadonlyMap<IrUnitId, PreparedIrPreparedUnit>;
  readonly directUnits: ReadonlyMap<IrUnitId, PreparedIrUnsupportedUnit>;
  readonly invariantUnits: ReadonlyMap<IrUnitId, PreparedIrInvariantUnit>;
  readonly components: readonly PreparedIrComponent[];
  readonly supportIntents: readonly PreparedIrSupportIntent[];
  readonly allocations: readonly PreparedIrAllocationRecord[];
  readonly provenance: readonly PreparedIrProvenanceRecord[];
}

/** @internal The validating builder in prepare.ts is the only supported caller. */
export function createValidatedPreparedIrProgram(input: ValidatedPreparedIrProgram): PreparedIrProgram {
  const entries = Object.freeze([...input.abiEntries]);
  const entryMap = new Map(entries.map((entry) => [entry.id, entry]));
  const abi: PreparedIrAbiSnapshot = Object.freeze({
    planningSealed: true as const,
    entries,
    get: (id: IrBindingId) => entryMap.get(id),
  });
  let emissionStarted = false;
  const program: PreparedIrProgram = Object.freeze({
    abi,
    units: input.units,
    preparedUnits: input.preparedUnits,
    directUnits: input.directUnits,
    invariantUnits: input.invariantUnits,
    components: Object.freeze([...input.components]),
    supportIntents: Object.freeze([...input.supportIntents]),
    allocations: Object.freeze([...input.allocations]),
    provenance: Object.freeze([...input.provenance]),
    sealed: true as const,
    beginEmission(): PreparedIrEmissionTransaction {
      if (program.invariantUnits.size > 0) {
        throw new PreparedIrProgramInvariantError(
          "program-has-invariant",
          `prepared program contains ${program.invariantUnits.size} invariant outcome(s)`,
        );
      }
      if (emissionStarted) {
        throw new PreparedIrProgramInvariantError("emission-already-started", "prepared program emission is one-shot");
      }
      emissionStarted = true;
      return new PreparedIrEmissionTransaction(program);
    },
  });
  return program;
}
