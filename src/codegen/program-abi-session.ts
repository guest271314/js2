// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { GlobalDef, Import, TypeDef, WasmFunction, WasmModule } from "../ir/types.js";
import type { IrBindingId, IrSourceId, IrUnitId, IrUnitInventory } from "../ir/identity.js";
import {
  LegacyAbiAdapter,
  ProgramAbiInvariantError,
  ProgramAbiMap,
  type ProgramAbiDerivedUnitRecord,
  type ProgramAbiPlanEntry,
  type ProgramAbiSlotSpace,
} from "../ir/program-abi.js";

const ABI_DOMAIN_ORDINAL = Object.freeze({
  callable: 0,
  global: 1,
  type: 2,
  class: 3,
  export: 4,
  support: 5,
} as const);

type ProgramAbiDomain = keyof typeof ABI_DOMAIN_ORDINAL;

/**
 * Closed domain order used by ABI planning. Producers record this value
 * explicitly, and the session verifies it against the draft's intent.
 */
export function programAbiDomainOrdinal(domain: ProgramAbiDomain): number {
  return ABI_DOMAIN_ORDINAL[domain];
}

/**
 * Structural order supplied by the producer that owns a declaration/support
 * role. The session derives source order from the inventory and rejects ties;
 * no encoded ID or Map insertion order participates.
 */
export interface ProgramAbiDraftOrder {
  readonly sourceId: IrSourceId;
  readonly declarationOrdinal: number;
  readonly domainOrdinal: number;
  readonly roleOrdinal: number;
  readonly derivedOrdinal: number;
}

type ProgramAbiDraftFromPlan<T> = T extends ProgramAbiPlanEntry
  ? Omit<T, "order"> & { readonly structuralOrder: ProgramAbiDraftOrder }
  : never;

/** A queued ABI intention before the session assigns its dense plan order. */
export type ProgramAbiDraft = ProgramAbiDraftFromPlan<ProgramAbiPlanEntry>;

/** Opaque session-owned cell that follows an explicitly reported type remap. */
export interface ProgramAbiTypeCell {
  readonly current: TypeDef | null;
}

type MutableProgramAbiTypeCell = {
  current: TypeDef | null;
};

export type ProgramAbiSlotLocator =
  | {
      readonly kind: "defined-function";
      readonly value: WasmFunction;
    }
  | {
      readonly kind: "import-function";
      readonly value: Import;
    }
  | {
      readonly kind: "defined-global";
      readonly value: GlobalDef;
    }
  | {
      readonly kind: "import-global";
      readonly value: Import;
    }
  | {
      readonly kind: "type-cell";
      readonly cell: ProgramAbiTypeCell;
    };

export interface PublishedProgramAbi {
  readonly abi: ProgramAbiMap;
  readonly legacy: LegacyAbiAdapter;
}

type SessionState = "open" | "publishing" | "published" | "failed";

function validOrdinal(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function locatorObject(locator: ProgramAbiSlotLocator): object {
  return locator.kind === "type-cell" ? locator.cell : locator.value;
}

function locatorSpace(locator: ProgramAbiSlotLocator): ProgramAbiSlotSpace {
  if (locator.kind === "defined-function" || locator.kind === "import-function") return "function";
  if (locator.kind === "defined-global" || locator.kind === "import-global") return "global";
  return "type";
}

function cloneDraft(draft: ProgramAbiDraft): ProgramAbiDraft {
  const intent =
    draft.intent.kind === "callable"
      ? {
          ...draft.intent,
          signature: {
            params: Object.freeze([...draft.intent.signature.params]),
            results: Object.freeze([...draft.intent.signature.results]),
          },
        }
      : { ...draft.intent };
  return Object.freeze({
    ...draft,
    structuralOrder: Object.freeze({ ...draft.structuralOrder }),
    intent: Object.freeze(intent),
  }) as ProgramAbiDraft;
}

function structuralOrderKey(sourceOrder: number, order: ProgramAbiDraftOrder): string {
  return [sourceOrder, order.declarationOrdinal, order.domainOrdinal, order.roleOrdinal, order.derivedOrdinal].join(
    ":",
  );
}

function compareDrafts(
  sourceOrderById: ReadonlyMap<IrSourceId, number>,
  a: ProgramAbiDraft,
  b: ProgramAbiDraft,
): number {
  const ao = a.structuralOrder;
  const bo = b.structuralOrder;
  return (
    sourceOrderById.get(ao.sourceId)! - sourceOrderById.get(bo.sourceId)! ||
    ao.declarationOrdinal - bo.declarationOrdinal ||
    ao.domainOrdinal - bo.domainOrdinal ||
    ao.roleOrdinal - bo.roleOrdinal ||
    ao.derivedOrdinal - bo.derivedOrdinal
  );
}

/**
 * Compilation-owned mutable staging area for ProgramAbiMap.
 *
 * Producers plan structural intentions and attach allocator-owned objects.
 * One publish boundary resolves those exact objects against the current module
 * layout, then seals the resulting ABI. This class never searches by a Wasm
 * or source label.
 */
export class ProgramAbiSession {
  private readonly sourceOrderById = new Map<IrSourceId, number>();
  private readonly drafts = new Map<IrBindingId, ProgramAbiDraft>();
  private readonly draftOrderOwners = new Map<string, IrBindingId>();
  private readonly derivedUnits = new Map<IrUnitId, ProgramAbiDerivedUnitRecord>();
  private readonly locators = new Map<IrBindingId, ProgramAbiSlotLocator>();
  private readonly locatorOwners = new Map<object, IrBindingId>();
  private readonly typeCells = new Set<ProgramAbiTypeCell>();
  private state: SessionState = "open";
  private publishedValue: PublishedProgramAbi | undefined;

  constructor(
    readonly inventory: IrUnitInventory,
    readonly module: WasmModule,
  ) {
    for (const source of inventory.sources) this.sourceOrderById.set(source.id, source.order);
  }

  /** Fail early if a context/module attempts to adopt another compilation's session. */
  assertModule(module: WasmModule): void {
    if (module !== this.module) {
      throw new ProgramAbiInvariantError(
        "context-session-mismatch",
        "ProgramAbiSession belongs to a different WasmModule",
      );
    }
  }

  get publication(): PublishedProgramAbi | undefined {
    return this.publishedValue;
  }

  plan(draft: ProgramAbiDraft): void {
    this.assertOpen(`plan ${draft.id}`);
    if (this.drafts.has(draft.id)) {
      throw new ProgramAbiInvariantError("duplicate-session-draft", `ABI draft ${draft.id} was planned more than once`);
    }
    const sourceOrder = this.sourceOrderById.get(draft.structuralOrder.sourceId);
    if (sourceOrder === undefined) {
      throw new ProgramAbiInvariantError(
        "unknown-draft-source",
        `ABI draft ${draft.id} references source ${draft.structuralOrder.sourceId} outside this inventory`,
      );
    }
    const components = [
      draft.structuralOrder.declarationOrdinal,
      draft.structuralOrder.domainOrdinal,
      draft.structuralOrder.roleOrdinal,
      draft.structuralOrder.derivedOrdinal,
    ];
    if (
      components.some((value) => !validOrdinal(value)) ||
      draft.structuralOrder.domainOrdinal !== programAbiDomainOrdinal(draft.intent.kind)
    ) {
      throw new ProgramAbiInvariantError("invalid-draft-order", `ABI draft ${draft.id} has invalid structural order`);
    }
    const key = structuralOrderKey(sourceOrder, draft.structuralOrder);
    const previous = this.draftOrderOwners.get(key);
    if (previous) {
      throw new ProgramAbiInvariantError(
        "duplicate-draft-order",
        `ABI drafts ${previous} and ${draft.id} share structural order ${key}`,
      );
    }
    this.drafts.set(draft.id, cloneDraft(draft));
    this.draftOrderOwners.set(key, draft.id);
  }

  registerDerivedUnit(record: ProgramAbiDerivedUnitRecord): void {
    this.assertOpen(`register derived unit ${record.id}`);
    if (this.derivedUnits.has(record.id)) {
      throw new ProgramAbiInvariantError(
        "duplicate-derived-unit",
        `derived unit ${record.id} was registered more than once`,
      );
    }
    this.derivedUnits.set(record.id, Object.freeze({ ...record }));
  }

  createTypeCell(type: TypeDef): ProgramAbiTypeCell {
    this.assertOpen("create a type cell");
    const cell: MutableProgramAbiTypeCell = { current: type };
    this.typeCells.add(cell);
    return cell;
  }

  /**
   * Follow one explicit allocator/DCE remap. Passing null records elimination;
   * publish then rejects a required slot rather than guessing by type name.
   */
  remapTypeCell(cell: ProgramAbiTypeCell, replacement: TypeDef | null): void {
    this.assertOpen("remap a type cell");
    if (!this.typeCells.has(cell)) {
      throw new ProgramAbiInvariantError("foreign-type-cell", "type cell belongs to another ABI session");
    }
    (cell as MutableProgramAbiTypeCell).current = replacement;
  }

  attachLocator(id: IrBindingId, locator: ProgramAbiSlotLocator): void {
    this.assertOpen(`attach slot locator for ${id}`);
    const draft = this.drafts.get(id);
    if (!draft) {
      throw new ProgramAbiInvariantError("unknown-locator-binding", `slot locator targets unplanned ABI draft ${id}`);
    }
    if (draft.slotPolicy !== "required") {
      throw new ProgramAbiInvariantError(
        "locator-not-required",
        `ABI draft ${id} has ${draft.slotPolicy} slot policy and cannot own a locator`,
      );
    }
    const actualSpace = locatorSpace(locator);
    if (
      draft.slotSpace !== actualSpace ||
      (locator.kind === "import-function" && locator.value.desc.kind !== "func") ||
      (locator.kind === "import-global" && locator.value.desc.kind !== "global")
    ) {
      throw new ProgramAbiInvariantError(
        "slot-locator-space-mismatch",
        `ABI draft ${id} requires ${draft.slotSpace} but received ${locator.kind}`,
      );
    }
    if (locator.kind === "type-cell" && !this.typeCells.has(locator.cell)) {
      throw new ProgramAbiInvariantError("foreign-type-cell", `type locator for ${id} belongs to another session`);
    }
    const object = locatorObject(locator);
    const previousOwner = this.locatorOwners.get(object);
    if (this.locators.has(id) || previousOwner !== undefined) {
      throw new ProgramAbiInvariantError(
        "duplicate-slot-locator",
        `allocator locator for ${id} is already owned by ${previousOwner ?? id}`,
      );
    }
    this.locators.set(id, Object.freeze({ ...locator }) as ProgramAbiSlotLocator);
    this.locatorOwners.set(object, id);
  }

  /**
   * Build, seal, bind, and complete the ABI exactly once.
   *
   * A failed publish closes the session too: callers must fix the producer and
   * rebuild the compilation instead of mutating a partially observed plan.
   */
  publish(module: WasmModule): PublishedProgramAbi {
    this.assertModule(module);
    if (this.state !== "open") {
      throw new ProgramAbiInvariantError(
        "session-publish-once",
        `ProgramAbiSession publish was already attempted (${this.state})`,
      );
    }
    this.state = "publishing";
    try {
      const abi = new ProgramAbiMap(this.inventory, [...this.derivedUnits.values()]);
      const drafts = [...this.drafts.values()].sort((a, b) => compareDrafts(this.sourceOrderById, a, b));
      const denseOrderBySource = new Map<IrSourceId, number>();
      for (const draft of drafts) {
        const { structuralOrder, ...planned } = draft;
        const declarationOrder = denseOrderBySource.get(structuralOrder.sourceId) ?? 0;
        denseOrderBySource.set(structuralOrder.sourceId, declarationOrder + 1);
        abi.plan({
          ...planned,
          order: {
            sourceOrder: this.sourceOrderById.get(structuralOrder.sourceId)!,
            declarationOrder,
          },
        } as ProgramAbiPlanEntry);
      }
      abi.sealPlan();

      for (const entry of abi.entries()) {
        if (entry.slotPolicy !== "required") continue;
        const locator = this.locators.get(entry.id);
        if (!locator) {
          throw new ProgramAbiInvariantError(
            "missing-required-locator",
            `required ABI binding ${entry.id} has no allocator locator`,
          );
        }
        abi.bindFinalIndex(entry.id, {
          space: entry.slotSpace,
          index: this.resolveLocator(module, entry.id, locator),
        });
      }
      abi.finishBinding();
      const publication = Object.freeze({
        abi,
        legacy: new LegacyAbiAdapter(abi),
      });
      this.publishedValue = publication;
      this.state = "published";
      return publication;
    } catch (error) {
      this.state = "failed";
      throw error;
    }
  }

  private assertOpen(action: string): void {
    if (this.state !== "open") {
      throw new ProgramAbiInvariantError(
        "session-closed",
        `cannot ${action} after ProgramAbiSession left planning state (${this.state})`,
      );
    }
  }

  private resolveLocator(module: WasmModule, id: IrBindingId, locator: ProgramAbiSlotLocator): number {
    if (locator.kind === "defined-function") {
      const position = this.uniqueObjectPosition(module.functions, locator.value);
      if (position >= 0) return this.importCount(module, "func") + position;
    } else if (locator.kind === "import-function") {
      const position = this.importPosition(module, locator.value, "func");
      if (position >= 0) return position;
    } else if (locator.kind === "defined-global") {
      const position = this.uniqueObjectPosition(module.globals, locator.value);
      if (position >= 0) return this.importCount(module, "global") + position;
    } else if (locator.kind === "import-global") {
      const position = this.importPosition(module, locator.value, "global");
      if (position >= 0) return position;
    } else {
      const current = locator.cell.current;
      if (current !== null) {
        const position = this.uniqueObjectPosition(module.types, current);
        if (position >= 0) return position;
      }
    }
    throw new ProgramAbiInvariantError(
      "eliminated-required-locator",
      `required ABI binding ${id} no longer has its allocator object in the published module`,
    );
  }

  private importCount(module: WasmModule, kind: "func" | "global"): number {
    let count = 0;
    for (const entry of module.imports) if (entry.desc.kind === kind) count++;
    return count;
  }

  private importPosition(module: WasmModule, target: Import, kind: "func" | "global"): number {
    let position = 0;
    let result = -1;
    for (const entry of module.imports) {
      if (entry.desc.kind !== kind) continue;
      if (entry === target) {
        if (result >= 0) {
          throw new ProgramAbiInvariantError(
            "duplicate-slot-locator",
            `allocator import object appears more than once in ${kind} space`,
          );
        }
        result = position;
      }
      position++;
    }
    return result;
  }

  private uniqueObjectPosition<T extends object>(values: readonly T[], target: T): number {
    const position = values.indexOf(target);
    if (position >= 0 && values.lastIndexOf(target) !== position) {
      throw new ProgramAbiInvariantError(
        "duplicate-slot-locator",
        "allocator object appears more than once in one module index space",
      );
    }
    return position;
  }
}
