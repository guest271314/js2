// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ts } from "../ts-api.js";
import {
  getIrInventoryScannerMetadata,
  type IrClassId,
  type IrClassRecord,
  type IrSourceId,
  type IrTerminalUnitRecord,
  type IrUnitId,
  type IrUnitInventory,
  type IrUnitRecord,
} from "./identity.js";

/**
 * Exact AST identity seam consumed by source planning.
 *
 * The inventory remains the single semantic population. These maps are only
 * validated views over the declarations encountered while that exact
 * inventory was scanned; no display-name or best-effort span join is used.
 * Synthetic inventory records without an AST declaration deliberately remain
 * absent from the declaration maps.
 */
export interface IrPlanningIdentityContext {
  readonly inventory: IrUnitInventory;
  readonly sourceIdBySourceFile: ReadonlyMap<ts.SourceFile, IrSourceId>;
  readonly sourceFileBySourceId: ReadonlyMap<IrSourceId, ts.SourceFile>;
  readonly unitIdByDeclaration: ReadonlyMap<ts.Node, IrUnitId>;
  readonly declarationByUnitId: ReadonlyMap<IrUnitId, ts.Node>;
  readonly terminalByUnitId: ReadonlyMap<IrUnitId, IrTerminalUnitRecord>;
  readonly classIdByDeclaration: ReadonlyMap<ts.ClassDeclaration | ts.ClassExpression, IrClassId>;
  readonly declarationByClassId: ReadonlyMap<IrClassId, ts.ClassDeclaration | ts.ClassExpression>;
  /** Module init is structurally owned by its source, not by an arbitrary AST anchor. */
  readonly moduleInitUnitIdBySourceId: ReadonlyMap<IrSourceId, IrUnitId>;
  readonly moduleInitUnitIdBySourceFile: ReadonlyMap<ts.SourceFile, IrUnitId>;
}

export type IrPlanningIdentityInvariantCode =
  | "untracked-inventory"
  | "source-record-mismatch"
  | "duplicate-source-id"
  | "duplicate-source-file"
  | "duplicate-unit-id"
  | "unit-record-mismatch"
  | "duplicate-unit-declaration"
  | "missing-unit-declaration"
  | "duplicate-terminal-id"
  | "terminal-record-mismatch"
  | "invalid-terminal-owner"
  | "duplicate-class-id"
  | "class-record-mismatch"
  | "duplicate-class-declaration"
  | "missing-class-declaration"
  | "invalid-module-init"
  | "duplicate-module-init";

export class IrPlanningIdentityInvariantError extends Error {
  constructor(
    readonly code: IrPlanningIdentityInvariantCode,
    message: string,
  ) {
    super(message);
    this.name = "IrPlanningIdentityInvariantError";
  }
}

/** Runtime read-only map: callers do not receive a mutable Map behind the type. */
class IrReadonlyMap<K, V> implements ReadonlyMap<K, V> {
  readonly #backingMap: ReadonlyMap<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#backingMap = new Map(entries);
    Object.freeze(this);
  }

  get size(): number {
    return this.#backingMap.size;
  }

  get(key: K): V | undefined {
    return this.#backingMap.get(key);
  }

  has(key: K): boolean {
    return this.#backingMap.has(key);
  }

  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#backingMap) callbackfn.call(thisArg, value, key, this);
  }

  entries(): MapIterator<[K, V]> {
    return this.#backingMap.entries();
  }

  keys(): MapIterator<K> {
    return this.#backingMap.keys();
  }

  values(): MapIterator<V> {
    return this.#backingMap.values();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#backingMap[Symbol.iterator]();
  }
}

function readonlyIdentityMap<K, V>(values: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  return new IrReadonlyMap(values);
}

function planningIdentityInvariant(code: IrPlanningIdentityInvariantCode, message: string): never {
  throw new IrPlanningIdentityInvariantError(code, message);
}

/**
 * Validate and expose the exact declaration identities captured while one
 * inventory was built. Passing a rebuilt/copied inventory is rejected: source
 * planning must share the same population and record objects as outcome/ABI
 * planning rather than reconstructing a parallel name-keyed view.
 */
export function buildIrPlanningIdentityContext(inventory: IrUnitInventory): IrPlanningIdentityContext {
  const scanned = getIrInventoryScannerMetadata(inventory);
  if (!scanned) {
    return planningIdentityInvariant(
      "untracked-inventory",
      "IR planning identity requires the exact inventory returned by buildIrUnitInventory",
    );
  }

  if (scanned.sources.length !== inventory.sources.length) {
    return planningIdentityInvariant(
      "source-record-mismatch",
      `inventory has ${inventory.sources.length} sources but its scanner captured ${scanned.sources.length}`,
    );
  }

  const sourceIdBySourceFile = new Map<ts.SourceFile, IrSourceId>();
  const sourceFileBySourceId = new Map<IrSourceId, ts.SourceFile>();
  for (let index = 0; index < inventory.sources.length; index++) {
    const source = inventory.sources[index]!;
    const scannedSource = scanned.sources[index]!;
    if (scannedSource.record !== source || scannedSource.sourceFile.fileName !== source.originalFileName) {
      return planningIdentityInvariant(
        "source-record-mismatch",
        `source ${index} no longer matches scanner record ${source.id}`,
      );
    }
    if (sourceFileBySourceId.has(source.id)) {
      return planningIdentityInvariant("duplicate-source-id", `source identity ${source.id} occurs more than once`);
    }
    if (sourceIdBySourceFile.has(scannedSource.sourceFile)) {
      return planningIdentityInvariant(
        "duplicate-source-file",
        `source file ${scannedSource.sourceFile.fileName} occurs more than once`,
      );
    }
    sourceIdBySourceFile.set(scannedSource.sourceFile, source.id);
    sourceFileBySourceId.set(source.id, scannedSource.sourceFile);
  }

  const unitsById = new Map<IrUnitId, IrUnitRecord>();
  for (const unit of inventory.allUnits) {
    if (unitsById.has(unit.id)) {
      return planningIdentityInvariant("duplicate-unit-id", `unit identity ${unit.id} occurs more than once`);
    }
    if (!sourceFileBySourceId.has(unit.sourceId)) {
      return planningIdentityInvariant(
        "unit-record-mismatch",
        `unit ${unit.id} belongs to unknown source ${unit.sourceId}`,
      );
    }
    unitsById.set(unit.id, unit);
  }

  const terminalByUnitId = new Map<IrUnitId, IrTerminalUnitRecord>();
  const moduleInitUnitIdBySourceId = new Map<IrSourceId, IrUnitId>();
  const moduleInitUnitIdBySourceFile = new Map<ts.SourceFile, IrUnitId>();
  for (const terminal of inventory.terminalUnits) {
    if (terminalByUnitId.has(terminal.id)) {
      return planningIdentityInvariant(
        "duplicate-terminal-id",
        `terminal identity ${terminal.id} occurs more than once`,
      );
    }
    if (unitsById.get(terminal.id) !== terminal || !terminal.terminal || terminal.terminalOwnerId !== terminal.id) {
      return planningIdentityInvariant(
        "terminal-record-mismatch",
        `terminal ${terminal.id} is not the exact terminal record in allUnits`,
      );
    }
    terminalByUnitId.set(terminal.id, terminal);

    const moduleIdentity = terminal.kind === "module-init" || terminal.observedKind === "module-init";
    if (!moduleIdentity) continue;
    if (
      terminal.kind !== "module-init" ||
      terminal.observedKind !== "module-init" ||
      terminal.lexicalOwnerId !== null
    ) {
      return planningIdentityInvariant(
        "invalid-module-init",
        `module-init terminal ${terminal.id} does not have structural source ownership`,
      );
    }
    if (moduleInitUnitIdBySourceId.has(terminal.sourceId)) {
      return planningIdentityInvariant(
        "duplicate-module-init",
        `source ${terminal.sourceId} owns more than one module-init unit`,
      );
    }
    const sourceFile = sourceFileBySourceId.get(terminal.sourceId);
    if (!sourceFile) {
      return planningIdentityInvariant(
        "invalid-module-init",
        `module-init ${terminal.id} belongs to unknown source ${terminal.sourceId}`,
      );
    }
    moduleInitUnitIdBySourceId.set(terminal.sourceId, terminal.id);
    moduleInitUnitIdBySourceFile.set(sourceFile, terminal.id);
  }
  for (const unit of inventory.allUnits) {
    if (unit.terminal && terminalByUnitId.get(unit.id) !== unit) {
      return planningIdentityInvariant(
        "terminal-record-mismatch",
        `terminal allUnits record ${unit.id} is absent from terminalUnits`,
      );
    }
    if (unit.terminalOwnerId !== null && !terminalByUnitId.has(unit.terminalOwnerId)) {
      return planningIdentityInvariant(
        "invalid-terminal-owner",
        `unit ${unit.id} references unknown terminal owner ${unit.terminalOwnerId}`,
      );
    }
  }

  const unitIdByDeclaration = new Map<ts.Node, IrUnitId>();
  const declarationByUnitId = new Map<IrUnitId, ts.Node>();
  for (const entry of scanned.units) {
    if (unitsById.get(entry.record.id) !== entry.record || entry.record.kind === "module-init") {
      return planningIdentityInvariant(
        "unit-record-mismatch",
        `scanned declaration does not match inventory unit ${entry.record.id}`,
      );
    }
    if (
      sourceIdBySourceFile.get(entry.sourceFile) !== entry.record.sourceId ||
      entry.declaration.getSourceFile() !== entry.sourceFile
    ) {
      return planningIdentityInvariant(
        "unit-record-mismatch",
        `unit ${entry.record.id} declaration belongs to a different source`,
      );
    }
    const priorDeclarationId = unitIdByDeclaration.get(entry.declaration);
    if (priorDeclarationId !== undefined) {
      return planningIdentityInvariant(
        "duplicate-unit-declaration",
        `AST declaration maps to both ${priorDeclarationId} and ${entry.record.id}`,
      );
    }
    if (declarationByUnitId.has(entry.record.id)) {
      return planningIdentityInvariant(
        "duplicate-unit-declaration",
        `unit ${entry.record.id} maps to more than one AST declaration`,
      );
    }
    unitIdByDeclaration.set(entry.declaration, entry.record.id);
    declarationByUnitId.set(entry.record.id, entry.declaration);
  }
  for (const unit of inventory.allUnits) {
    if (unit.kind === "module-init") {
      if (declarationByUnitId.has(unit.id)) {
        return planningIdentityInvariant(
          "invalid-module-init",
          `module-init ${unit.id} must be owned by its source rather than an AST declaration`,
        );
      }
      continue;
    }
    if (!declarationByUnitId.has(unit.id) && unit.syntheticRole === undefined) {
      return planningIdentityInvariant(
        "missing-unit-declaration",
        `source unit ${unit.id} has no scanned AST declaration`,
      );
    }
  }

  const classesById = new Map<IrClassId, IrClassRecord>();
  for (const classRecord of inventory.classes) {
    if (classesById.has(classRecord.id)) {
      return planningIdentityInvariant("duplicate-class-id", `class identity ${classRecord.id} occurs more than once`);
    }
    if (!sourceFileBySourceId.has(classRecord.sourceId)) {
      return planningIdentityInvariant(
        "class-record-mismatch",
        `class ${classRecord.id} belongs to unknown source ${classRecord.sourceId}`,
      );
    }
    classesById.set(classRecord.id, classRecord);
  }

  const classIdByDeclaration = new Map<ts.ClassDeclaration | ts.ClassExpression, IrClassId>();
  const declarationByClassId = new Map<IrClassId, ts.ClassDeclaration | ts.ClassExpression>();
  for (const entry of scanned.classes) {
    if (classesById.get(entry.record.id) !== entry.record) {
      return planningIdentityInvariant(
        "class-record-mismatch",
        `scanned declaration does not match inventory class ${entry.record.id}`,
      );
    }
    if (
      sourceIdBySourceFile.get(entry.sourceFile) !== entry.record.sourceId ||
      entry.declaration.getSourceFile() !== entry.sourceFile
    ) {
      return planningIdentityInvariant(
        "class-record-mismatch",
        `class ${entry.record.id} declaration belongs to a different source`,
      );
    }
    const priorDeclarationId = classIdByDeclaration.get(entry.declaration);
    if (priorDeclarationId !== undefined) {
      return planningIdentityInvariant(
        "duplicate-class-declaration",
        `class declaration maps to both ${priorDeclarationId} and ${entry.record.id}`,
      );
    }
    if (declarationByClassId.has(entry.record.id)) {
      return planningIdentityInvariant(
        "duplicate-class-declaration",
        `class ${entry.record.id} maps to more than one AST declaration`,
      );
    }
    classIdByDeclaration.set(entry.declaration, entry.record.id);
    declarationByClassId.set(entry.record.id, entry.declaration);
  }
  for (const classRecord of inventory.classes) {
    if (!declarationByClassId.has(classRecord.id) && classRecord.syntheticRole === undefined) {
      return planningIdentityInvariant(
        "missing-class-declaration",
        `source class ${classRecord.id} has no scanned AST declaration`,
      );
    }
  }

  return Object.freeze({
    inventory,
    sourceIdBySourceFile: readonlyIdentityMap(sourceIdBySourceFile),
    sourceFileBySourceId: readonlyIdentityMap(sourceFileBySourceId),
    unitIdByDeclaration: readonlyIdentityMap(unitIdByDeclaration),
    declarationByUnitId: readonlyIdentityMap(declarationByUnitId),
    terminalByUnitId: readonlyIdentityMap(terminalByUnitId),
    classIdByDeclaration: readonlyIdentityMap(classIdByDeclaration),
    declarationByClassId: readonlyIdentityMap(declarationByClassId),
    moduleInitUnitIdBySourceId: readonlyIdentityMap(moduleInitUnitIdBySourceId),
    moduleInitUnitIdBySourceFile: readonlyIdentityMap(moduleInitUnitIdBySourceFile),
  });
}
