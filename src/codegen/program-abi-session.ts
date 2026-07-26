// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { GlobalDef, Import, TypeDef, WasmFunction, WasmModule } from "../ir/types.js";
import type { IrBindingId, IrClassId, IrSourceId, IrUnitId, IrUnitInventory } from "../ir/identity.js";
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

export type ProgramAbiDomain = keyof typeof ABI_DOMAIN_ORDINAL;

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

export interface ProgramAbiDraftSuborder {
  readonly domain: ProgramAbiDomain;
  readonly roleOrdinal: number;
  readonly derivedOrdinal?: number;
}

interface ProgramAbiDeclarationAnchor {
  readonly sourceId: IrSourceId;
  readonly declarationOrdinal: number;
}

/**
 * Canonical source-local draft ordering derived from the inventory population.
 *
 * `IrUnitRecord.ordinal` is only local to a structural owner/kind, so it is
 * never used here as a whole-source ordinal. Exact unit anchors instead use
 * their position in `inventory.allUnits`; source and class anchors occupy
 * disjoint slots around that authoritative sequence.
 */
export class ProgramAbiStructuralOrder {
  private readonly sourceAnchors = new Map<IrSourceId, ProgramAbiDeclarationAnchor>();
  private readonly unitAnchors = new Map<IrUnitId, ProgramAbiDeclarationAnchor>();
  private readonly classAnchors = new Map<IrClassId, ProgramAbiDeclarationAnchor>();
  private readonly derivedParents = new Map<IrUnitId, IrUnitId>();

  constructor(readonly inventory: IrUnitInventory) {
    const sourceLocalCounts = new Map<IrSourceId, number>();
    for (const source of inventory.sources) {
      if (this.sourceAnchors.has(source.id)) {
        throw new ProgramAbiInvariantError(
          "ambiguous-order-anchor",
          `source ${source.id} occurs more than once in the ABI ordering inventory`,
        );
      }
      this.sourceAnchors.set(source.id, Object.freeze({ sourceId: source.id, declarationOrdinal: 0 }));
      sourceLocalCounts.set(source.id, 0);
    }

    for (const unit of inventory.allUnits) {
      if (this.unitAnchors.has(unit.id)) {
        throw new ProgramAbiInvariantError(
          "ambiguous-order-anchor",
          `unit ${unit.id} occurs more than once in the ABI ordering inventory`,
        );
      }
      const sourceCount = sourceLocalCounts.get(unit.sourceId);
      if (sourceCount === undefined) {
        throw new ProgramAbiInvariantError(
          "unknown-order-anchor",
          `unit ${unit.id} references source ${unit.sourceId} outside the ABI ordering inventory`,
        );
      }
      this.unitAnchors.set(
        unit.id,
        Object.freeze({
          sourceId: unit.sourceId,
          declarationOrdinal: (sourceCount + 1) * 2,
        }),
      );
      sourceLocalCounts.set(unit.sourceId, sourceCount + 1);
    }

    const classOrderOwners = new Map<string, IrClassId>();
    for (const classRecord of inventory.classes) {
      if (this.classAnchors.has(classRecord.id)) {
        throw new ProgramAbiInvariantError(
          "ambiguous-order-anchor",
          `class ${classRecord.id} occurs more than once in the ABI ordering inventory`,
        );
      }
      const member = inventory.allUnits.find(
        (unit) => unit.sourceId === classRecord.sourceId && unit.lexicalOwnerId === classRecord.id,
      );
      const memberAnchor = member === undefined ? undefined : this.unitAnchors.get(member.id);
      if (!memberAnchor) {
        throw new ProgramAbiInvariantError(
          "unknown-order-anchor",
          `class ${classRecord.id} has no exact unit anchor in inventory.allUnits`,
        );
      }
      const anchor = Object.freeze({
        sourceId: classRecord.sourceId,
        declarationOrdinal: memberAnchor.declarationOrdinal - 1,
      });
      const key = `${anchor.sourceId}\u0000${anchor.declarationOrdinal}`;
      const previous = classOrderOwners.get(key);
      if (previous !== undefined) {
        throw new ProgramAbiInvariantError(
          "ambiguous-order-anchor",
          `classes ${previous} and ${classRecord.id} share ABI order anchor ${anchor.declarationOrdinal}`,
        );
      }
      classOrderOwners.set(key, classRecord.id);
      this.classAnchors.set(classRecord.id, anchor);
    }
  }

  registerDerivedUnit(id: IrUnitId, parentId: IrUnitId): void {
    if (this.unitAnchors.has(id) || this.derivedParents.has(id)) {
      throw new ProgramAbiInvariantError(
        "ambiguous-order-anchor",
        `derived unit ${id} was registered more than once with the ABI ordering sidecar`,
      );
    }
    this.derivedParents.set(id, parentId);
  }

  forSource(sourceId: IrSourceId, suborder: ProgramAbiDraftSuborder): ProgramAbiDraftOrder {
    return this.orderFor(this.sourceAnchors.get(sourceId), `source ${sourceId}`, suborder);
  }

  forUnit(unitId: IrUnitId, suborder: ProgramAbiDraftSuborder): ProgramAbiDraftOrder {
    return this.orderFor(this.resolveUnitAnchor(unitId, new Set()), `unit ${unitId}`, suborder);
  }

  forClass(classId: IrClassId, suborder: ProgramAbiDraftSuborder): ProgramAbiDraftOrder {
    return this.orderFor(this.classAnchors.get(classId), `class ${classId}`, suborder);
  }

  private orderFor(
    anchor: ProgramAbiDeclarationAnchor | undefined,
    description: string,
    suborder: ProgramAbiDraftSuborder,
  ): ProgramAbiDraftOrder {
    if (!anchor) {
      throw new ProgramAbiInvariantError(
        "unknown-order-anchor",
        `${description} is outside the ABI ordering inventory`,
      );
    }
    const derivedOrdinal = suborder.derivedOrdinal ?? 0;
    if (!validOrdinal(suborder.roleOrdinal) || !validOrdinal(derivedOrdinal)) {
      throw new ProgramAbiInvariantError("invalid-draft-order", `${description} has an invalid ABI suborder`);
    }
    return Object.freeze({
      sourceId: anchor.sourceId,
      declarationOrdinal: anchor.declarationOrdinal,
      domainOrdinal: programAbiDomainOrdinal(suborder.domain),
      roleOrdinal: suborder.roleOrdinal,
      derivedOrdinal,
    });
  }

  private resolveUnitAnchor(unitId: IrUnitId, visiting: Set<IrUnitId>): ProgramAbiDeclarationAnchor | undefined {
    const inventoryAnchor = this.unitAnchors.get(unitId);
    if (inventoryAnchor) return inventoryAnchor;
    const parentId = this.derivedParents.get(unitId);
    if (parentId === undefined) return undefined;
    if (visiting.has(unitId)) {
      throw new ProgramAbiInvariantError("ambiguous-order-anchor", `derived ABI order cycle includes ${unitId}`);
    }
    visiting.add(unitId);
    const parent = this.resolveUnitAnchor(parentId, visiting);
    visiting.delete(unitId);
    return parent;
  }
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

function intentsEqual(a: ProgramAbiDraft["intent"], b: ProgramAbiDraft["intent"]): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "callable" && b.kind === "callable") {
    return (
      a.origin === b.origin &&
      a.unitId === b.unitId &&
      a.signature.params.length === b.signature.params.length &&
      a.signature.params.every((value, index) => value === b.signature.params[index]) &&
      a.signature.results.length === b.signature.results.length &&
      a.signature.results.every((value, index) => value === b.signature.results[index])
    );
  }
  if (a.kind === "global" && b.kind === "global") {
    return a.origin === b.origin && a.valueType === b.valueType && a.mutable === b.mutable;
  }
  if (a.kind === "type" && b.kind === "type") return a.shapeKey === b.shapeKey;
  if (a.kind === "export" && b.kind === "export") {
    return a.externalName === b.externalName && a.targetId === b.targetId;
  }
  if (a.kind === "class" && b.kind === "class") {
    return a.classId === b.classId && a.layoutKey === b.layoutKey;
  }
  return a.kind === "support" && b.kind === "support" && a.role === b.role;
}

function draftsEqual(a: ProgramAbiDraft, b: ProgramAbiDraft): boolean {
  const ar = a as ProgramAbiDraft & {
    readonly aliasOf?: IrBindingId;
    readonly slotSpace?: ProgramAbiSlotSpace;
  };
  const br = b as ProgramAbiDraft & {
    readonly aliasOf?: IrBindingId;
    readonly slotSpace?: ProgramAbiSlotSpace;
  };
  return (
    a.id === b.id &&
    a.displayName === b.displayName &&
    a.structuralReferenceKey === b.structuralReferenceKey &&
    a.slotPolicy === b.slotPolicy &&
    ar.slotSpace === br.slotSpace &&
    ar.aliasOf === br.aliasOf &&
    a.structuralOrder.sourceId === b.structuralOrder.sourceId &&
    a.structuralOrder.declarationOrdinal === b.structuralOrder.declarationOrdinal &&
    a.structuralOrder.domainOrdinal === b.structuralOrder.domainOrdinal &&
    a.structuralOrder.roleOrdinal === b.structuralOrder.roleOrdinal &&
    a.structuralOrder.derivedOrdinal === b.structuralOrder.derivedOrdinal &&
    intentsEqual(a.intent, b.intent)
  );
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
  private readonly structuralReferenceKeys = new Map<IrBindingId, string>();
  private readonly typeCells = new Set<ProgramAbiTypeCell>();
  private readonly typeCellsByObject = new Map<TypeDef, MutableProgramAbiTypeCell>();
  private state: SessionState = "open";
  private publishedValue: PublishedProgramAbi | undefined;
  readonly structuralOrder: ProgramAbiStructuralOrder;

  constructor(
    readonly inventory: IrUnitInventory,
    readonly module: WasmModule,
  ) {
    for (const source of inventory.sources) this.sourceOrderById.set(source.id, source.order);
    this.structuralOrder = new ProgramAbiStructuralOrder(inventory);
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

  hasPlan(id: IrBindingId): boolean {
    return this.drafts.has(id);
  }

  getDraft(id: IrBindingId): ProgramAbiDraft | undefined {
    return this.drafts.get(id);
  }

  /**
   * Plan once or prove that a repeated producer observation is byte-for-byte
   * equivalent at the structural contract level.
   */
  ensurePlan(draft: ProgramAbiDraft): void {
    this.assertOpen(`ensure plan ${draft.id}`);
    const existing = this.drafts.get(draft.id);
    if (!existing) {
      this.plan(draft);
      return;
    }
    if (!draftsEqual(existing, cloneDraft(draft))) {
      throw new ProgramAbiInvariantError(
        "session-draft-mismatch",
        `ABI draft ${draft.id} was observed with a different plan contract`,
      );
    }
  }

  hasLocator(id: IrBindingId, allocatorObject?: object): boolean {
    const locator = this.locators.get(id);
    return locator !== undefined && (allocatorObject === undefined || locatorObject(locator) === allocatorObject);
  }

  registerStructuralReference(id: IrBindingId, key: string): void {
    this.assertOpen(`register structural reference for ${id}`);
    this.assertStructuralReference(id, key, true);
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
    if (
      draft.structuralReferenceKey !== undefined &&
      (typeof draft.structuralReferenceKey !== "string" || draft.structuralReferenceKey.length === 0)
    ) {
      throw new ProgramAbiInvariantError(
        "invalid-binding-reference",
        `ABI draft ${draft.id} has an invalid structural reference key`,
      );
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
    this.structuralOrder.registerDerivedUnit(record.id, record.parentId);
  }

  createTypeCell(type: TypeDef): ProgramAbiTypeCell {
    this.assertOpen("create a type cell");
    if (this.typeCellsByObject.has(type)) {
      throw new ProgramAbiInvariantError(
        "duplicate-type-cell",
        "allocator type object already belongs to an ABI type cell",
      );
    }
    const cell: MutableProgramAbiTypeCell = { current: type };
    this.typeCells.add(cell);
    this.typeCellsByObject.set(type, cell);
    return cell;
  }

  typeCellFor(type: TypeDef): ProgramAbiTypeCell | undefined {
    return this.typeCellsByObject.get(type);
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
    const current = cell.current;
    if (current === null) {
      throw new ProgramAbiInvariantError("type-remap-mismatch", "eliminated ABI type cell cannot be remapped again");
    }
    this.remapTypeObject(current, replacement);
  }

  /** Follow one exact old TypeDef object through an allocator/DCE remap. */
  remapTypeObject(previous: TypeDef, replacement: TypeDef | null): void {
    this.remapTypeObjects([[previous, replacement]]);
  }

  /**
   * Apply an allocator/DCE remap in linear time from the old type population.
   *
   * Historical old-object keys remain session-owned so stale or duplicate
   * remap reports reject instead of silently attaching to another cell.
   */
  remapTypeObjects(remaps: Iterable<readonly [TypeDef, TypeDef | null]>): void {
    this.assertOpen("remap type objects");
    const pending = [...remaps];
    const previousObjects = new Set<TypeDef>();
    const replacementOwners = new Map<TypeDef, MutableProgramAbiTypeCell>();
    const validated: Array<readonly [MutableProgramAbiTypeCell, TypeDef, TypeDef | null]> = [];

    for (const [previous, replacement] of pending) {
      if (previousObjects.has(previous)) {
        throw new ProgramAbiInvariantError("type-remap-mismatch", "allocator type object was remapped more than once");
      }
      previousObjects.add(previous);
      const cell = this.typeCellsByObject.get(previous);
      if (!cell) {
        throw new ProgramAbiInvariantError(
          "foreign-type-object",
          "allocator type object does not belong to this ABI session",
        );
      }
      if (cell.current !== previous) {
        throw new ProgramAbiInvariantError(
          "type-remap-mismatch",
          "allocator type remap does not start at the cell's current object",
        );
      }
      if (replacement !== null) {
        const historicalOwner = this.typeCellsByObject.get(replacement);
        const pendingOwner = replacementOwners.get(replacement);
        if (
          (historicalOwner !== undefined && historicalOwner !== cell) ||
          (pendingOwner !== undefined && pendingOwner !== cell)
        ) {
          throw new ProgramAbiInvariantError(
            "ambiguous-type-remap",
            "allocator replacement type object would belong to multiple ABI cells",
          );
        }
        replacementOwners.set(replacement, cell);
      }
      validated.push([cell, previous, replacement]);
    }

    for (const [cell, , replacement] of validated) {
      cell.current = replacement;
      if (replacement !== null) this.typeCellsByObject.set(replacement, cell);
    }
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

  replaceDefinedFunctionLocator(id: IrBindingId, previous: WasmFunction, replacement: WasmFunction): void {
    this.replaceDefinedLocator(id, "defined-function", previous, replacement);
  }

  replaceDefinedGlobalLocator(id: IrBindingId, previous: GlobalDef, replacement: GlobalDef): void {
    this.replaceDefinedLocator(id, "defined-global", previous, replacement);
  }

  /**
   * Resolve one planned binding against the module's current, provisional
   * layout. Publication deliberately repeats exact-object resolution after
   * index-space freeze and records that later result as authoritative.
   */
  resolveCurrentIndex(
    id: IrBindingId,
    expectedSpace: ProgramAbiSlotSpace,
    structuralReferenceKey: string,
    module: WasmModule = this.module,
  ): number {
    this.assertModule(module);
    this.assertStructuralReference(id, structuralReferenceKey, this.state === "open");
    if (this.state === "published") {
      const finalIndex = this.publishedValue!.abi.resolveFinalIndex(id);
      if (!finalIndex || finalIndex.space !== expectedSpace) {
        throw new ProgramAbiInvariantError(
          "final-index-space-mismatch",
          `published ABI binding ${id} does not resolve in ${expectedSpace} space`,
        );
      }
      return finalIndex.index;
    }
    this.assertOpen(`resolve current slot for ${id}`);
    const canonical = this.canonicalDraft(id);
    if (canonical.slotPolicy !== "required" || canonical.slotSpace !== expectedSpace) {
      throw new ProgramAbiInvariantError(
        "slot-locator-space-mismatch",
        `ABI binding ${id} does not resolve to a required ${expectedSpace} slot`,
      );
    }
    const locator = this.locators.get(canonical.id);
    if (!locator) {
      throw new ProgramAbiInvariantError(
        "missing-required-locator",
        `ABI binding ${canonical.id} has no allocator locator`,
      );
    }
    if (locatorSpace(locator) !== expectedSpace) {
      throw new ProgramAbiInvariantError(
        "slot-locator-space-mismatch",
        `ABI binding ${canonical.id} owns ${locator.kind}, not ${expectedSpace}`,
      );
    }
    return this.resolveLocator(module, canonical.id, locator);
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

  private assertStructuralReference(id: IrBindingId, key: string, record: boolean): void {
    const draft = this.drafts.get(id);
    if (!draft) {
      throw new ProgramAbiInvariantError("unknown-binding", `structural reference targets unplanned ABI draft ${id}`);
    }
    if (typeof key !== "string" || key.length === 0) {
      throw new ProgramAbiInvariantError(
        "invalid-binding-reference",
        `ABI binding ${id} received an invalid structural reference key`,
      );
    }
    const canonicalKey = draft.structuralReferenceKey;
    if (canonicalKey === undefined) {
      throw new ProgramAbiInvariantError(
        "missing-binding-reference",
        `ABI binding ${id} did not plan canonical structural reference metadata`,
      );
    }
    const previous = this.structuralReferenceKeys.get(id);
    if (canonicalKey !== key || (previous !== undefined && previous !== key)) {
      throw new ProgramAbiInvariantError(
        "binding-reference-mismatch",
        `ABI binding ${id} does not match the supplied structural reference payload`,
      );
    }
    if (record) this.structuralReferenceKeys.set(id, key);
  }

  private canonicalDraft(id: IrBindingId): ProgramAbiDraft {
    let current = this.drafts.get(id);
    if (!current) throw new ProgramAbiInvariantError("unknown-binding", `ABI binding ${id} was not planned`);
    const visited = new Set<IrBindingId>();
    while (current.slotPolicy === "alias") {
      if (visited.has(current.id)) {
        throw new ProgramAbiInvariantError("alias-cycle", `ABI draft alias cycle includes ${current.id}`);
      }
      visited.add(current.id);
      const target = this.drafts.get(current.aliasOf);
      if (!target) {
        throw new ProgramAbiInvariantError(
          "missing-alias-target",
          `ABI draft alias ${current.id} targets unplanned binding ${current.aliasOf}`,
        );
      }
      current = target;
    }
    return current;
  }

  private replaceDefinedLocator<T extends WasmFunction | GlobalDef>(
    id: IrBindingId,
    kind: "defined-function" | "defined-global",
    previous: T,
    replacement: T,
  ): void {
    this.assertOpen(`replace slot locator for ${id}`);
    const draft = this.drafts.get(id);
    if (!draft) {
      throw new ProgramAbiInvariantError("unknown-locator-binding", `slot locator targets unplanned ABI draft ${id}`);
    }
    const expectedSpace: ProgramAbiSlotSpace = kind === "defined-function" ? "function" : "global";
    if (draft.slotPolicy !== "required" || draft.slotSpace !== expectedSpace) {
      throw new ProgramAbiInvariantError(
        "slot-locator-space-mismatch",
        `ABI draft ${id} does not own a required ${expectedSpace} locator`,
      );
    }
    const current = this.locators.get(id);
    if (!current) {
      throw new ProgramAbiInvariantError("missing-required-locator", `ABI binding ${id} has no allocator locator`);
    }
    if (current.kind !== kind || current.value !== previous || this.locatorOwners.get(previous) !== id) {
      throw new ProgramAbiInvariantError(
        "locator-remap-mismatch",
        `ABI binding ${id} does not own the supplied previous ${kind} object`,
      );
    }
    if (replacement === previous) return;
    const replacementOwner = this.locatorOwners.get(replacement);
    if (replacementOwner !== undefined) {
      throw new ProgramAbiInvariantError(
        "duplicate-slot-locator",
        `replacement allocator object for ${id} is already owned by ${replacementOwner}`,
      );
    }
    this.locatorOwners.delete(previous);
    this.locatorOwners.set(replacement, id);
    this.locators.set(
      id,
      Object.freeze({ kind, value: replacement }) as Extract<ProgramAbiSlotLocator, { readonly kind: typeof kind }>,
    );
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
