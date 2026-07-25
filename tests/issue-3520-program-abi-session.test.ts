// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import {
  ProgramAbiSession,
  programAbiDomainOrdinal,
  type ProgramAbiDraft,
} from "../src/codegen/program-abi-session.js";
import {
  buildIrUnitInventory,
  createDerivedIrUnitId,
  createIrBindingId,
  type IrBindingId,
  type IrSourceId,
  type IrUnitId,
  type IrUnitInventory,
} from "../src/ir/identity.js";
import {
  ProgramAbiInvariantError,
  ProgramAbiMap,
  type ProgramAbiDerivedUnitRecord,
  type ProgramAbiInvariantCode,
} from "../src/ir/program-abi.js";
import {
  createEmptyModule,
  type GlobalDef,
  type Import,
  type TypeDef,
  type WasmFunction,
  type WasmModule,
} from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

const VOID_SIGNATURE = Object.freeze({
  params: Object.freeze([]),
  results: Object.freeze([]),
});

interface SessionFixture {
  readonly inventory: IrUnitInventory;
  readonly sourceId: IrSourceId;
  readonly sourceOrder: number;
  readonly firstUnitId: IrUnitId;
  readonly secondUnitId: IrUnitId;
}

function source(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function sessionFixture(fileName = "/repo/session.ts"): SessionFixture {
  const file = source(
    fileName,
    `
      function first() {}
      function second() {}
    `,
  );
  const inventory = buildIrUnitInventory([file], { entrySource: file });
  const first = inventory.allUnits.find((unit) => unit.kind === "top-level-function" && unit.displayName === "first");
  const second = inventory.allUnits.find((unit) => unit.kind === "top-level-function" && unit.displayName === "second");
  if (!first || !second) throw new Error("invalid ABI session fixture");
  return {
    inventory,
    sourceId: inventory.sources[0]!.id,
    sourceOrder: inventory.sources[0]!.order,
    firstUnitId: first.id,
    secondUnitId: second.id,
  };
}

function binding(
  fixture: SessionFixture,
  domain: "callable" | "global" | "type" | "export" | "support",
  role: string,
  ownerId: IrSourceId | IrUnitId = fixture.sourceId,
): IrBindingId {
  return createIrBindingId({ ownerId, domain, role });
}

function structuralOrder(
  fixture: SessionFixture,
  domain: ProgramAbiDraft["intent"]["kind"],
  declarationOrdinal: number,
  roleOrdinal = 0,
  derivedOrdinal = 0,
) {
  return {
    sourceId: fixture.sourceId,
    declarationOrdinal,
    domainOrdinal: programAbiDomainOrdinal(domain),
    roleOrdinal,
    derivedOrdinal,
  };
}

function callableDraft(
  fixture: SessionFixture,
  id: IrBindingId,
  unitId: IrUnitId,
  displayName: string,
  declarationOrdinal: number,
  roleOrdinal = 0,
  derivedOrdinal = 0,
): ProgramAbiDraft {
  return {
    id,
    structuralOrder: structuralOrder(fixture, "callable", declarationOrdinal, roleOrdinal, derivedOrdinal),
    displayName,
    slotPolicy: "required",
    slotSpace: "function",
    intent: {
      kind: "callable",
      origin: "source",
      signature: VOID_SIGNATURE,
      unitId,
    },
  };
}

function globalDraft(
  fixture: SessionFixture,
  id: IrBindingId,
  displayName: string,
  declarationOrdinal: number,
): ProgramAbiDraft {
  return {
    id,
    structuralOrder: structuralOrder(fixture, "global", declarationOrdinal),
    displayName,
    slotPolicy: "required",
    slotSpace: "global",
    intent: {
      kind: "global",
      origin: "source",
      valueType: "i32",
      mutable: true,
    },
  };
}

function typeDraft(
  fixture: SessionFixture,
  id: IrBindingId,
  displayName: string,
  declarationOrdinal: number,
): ProgramAbiDraft {
  return {
    id,
    structuralOrder: structuralOrder(fixture, "type", declarationOrdinal),
    displayName,
    slotPolicy: "required",
    slotSpace: "type",
    intent: { kind: "type", shapeKey: "struct:x=i32" },
  };
}

function callableAliasDraft(
  fixture: SessionFixture,
  id: IrBindingId,
  targetId: IrBindingId,
  displayName: string,
  declarationOrdinal: number,
): ProgramAbiDraft {
  return {
    id,
    structuralOrder: structuralOrder(fixture, "callable", declarationOrdinal),
    displayName,
    slotPolicy: "alias",
    aliasOf: targetId,
    intent: {
      kind: "callable",
      origin: "import",
      signature: VOID_SIGNATURE,
    },
  };
}

function supportDraft(fixture: SessionFixture, id: IrBindingId, declarationOrdinal: number): ProgramAbiDraft {
  return {
    id,
    structuralOrder: structuralOrder(fixture, "support", declarationOrdinal),
    displayName: "support",
    slotPolicy: "none",
    intent: { kind: "support", role: "session-marker" },
  };
}

function wasmFunction(name: string, typeIdx = 0): WasmFunction {
  return { name, typeIdx, locals: [], body: [], exported: false };
}

function wasmGlobal(name: string): GlobalDef {
  return {
    name,
    type: { kind: "i32" },
    mutable: true,
    init: [{ op: "i32.const", value: 0 }],
  };
}

function functionType(name: string): TypeDef {
  return { kind: "func", name, params: [], results: [] };
}

function expectInvariant(action: () => unknown, code: ProgramAbiInvariantCode): ProgramAbiInvariantError {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProgramAbiInvariantError);
  expect((caught as ProgramAbiInvariantError).code).toBe(code);
  return caught as ProgramAbiInvariantError;
}

interface DeterministicSession {
  readonly publication: ReturnType<ProgramAbiSession["publish"]>;
  readonly ids: {
    readonly first: IrBindingId;
    readonly second: IrBindingId;
    readonly global: IrBindingId;
    readonly type: IrBindingId;
    readonly alias: IrBindingId;
  };
}

function buildDeterministicSession(reverse: boolean): DeterministicSession {
  const fixture = sessionFixture();
  const module = createEmptyModule();
  const fnType = functionType("$void");
  const recordType: TypeDef = { kind: "struct", name: "$Record", fields: [] };
  const firstFn = wasmFunction("same");
  const secondFn = wasmFunction("same");
  const global = wasmGlobal("same");
  module.types.push(fnType, recordType);
  module.functions.push(firstFn, secondFn);
  module.globals.push(global);

  const first = binding(fixture, "callable", "body", fixture.firstUnitId);
  const second = binding(fixture, "callable", "body", fixture.secondUnitId);
  const globalId = binding(fixture, "global", "state");
  const typeId = binding(fixture, "type", "record");
  const alias = binding(fixture, "callable", "alias");
  const support = binding(fixture, "support", "marker");
  const drafts = [
    callableDraft(fixture, first, fixture.firstUnitId, "same", 0),
    callableDraft(fixture, second, fixture.secondUnitId, "same", 1),
    globalDraft(fixture, globalId, "same", 2),
    typeDraft(fixture, typeId, "same", 3),
    callableAliasDraft(fixture, alias, first, "same-alias", 4),
    supportDraft(fixture, support, 5),
  ];

  const session = new ProgramAbiSession(fixture.inventory, module);
  for (const draft of reverse ? [...drafts].reverse() : drafts) session.plan(draft);
  const typeCell = session.createTypeCell(recordType);
  session.attachLocator(first, { kind: "defined-function", value: firstFn });
  session.attachLocator(second, { kind: "defined-function", value: secondFn });
  session.attachLocator(globalId, { kind: "defined-global", value: global });
  session.attachLocator(typeId, { kind: "type-cell", cell: typeCell });
  return {
    publication: session.publish(module),
    ids: { first, second, global: globalId, type: typeId, alias },
  };
}

describe("#3520 ProgramAbiSession", () => {
  it("publishes deterministic dense plans from structural order, not registration order", () => {
    const forward = buildDeterministicSession(false);
    const reversed = buildDeterministicSession(true);

    expect(reversed.publication.abi.entries().map((entry) => entry.id)).toEqual(
      forward.publication.abi.entries().map((entry) => entry.id),
    );
    expect(forward.publication.abi.entries().map((entry) => entry.order.declarationOrder)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(forward.publication.abi.resolveFinalIndex(forward.ids.first)).toEqual({
      space: "function",
      index: 0,
    });
    expect(forward.publication.abi.resolveFinalIndex(forward.ids.second)).toEqual({
      space: "function",
      index: 1,
    });
    expect(forward.publication.abi.resolveFinalIndex(forward.ids.global)).toEqual({
      space: "global",
      index: 0,
    });
    expect(forward.publication.abi.resolveFinalIndex(forward.ids.type)).toEqual({
      space: "type",
      index: 1,
    });
    expect(forward.publication.abi.resolveFinalIndex(forward.ids.alias)).toEqual({
      space: "function",
      index: 0,
    });

    const required = forward.publication.abi.entries().filter((entry) => entry.slotPolicy === "required");
    const finalKeys = required.map((entry) => {
      const final = forward.publication.abi.resolveFinalIndex(entry.id)!;
      return `${final.space}:${final.index}`;
    });
    expect(finalKeys).toHaveLength(4);
    expect(new Set(finalKeys)).toHaveLength(4);
    expectInvariant(
      () => forward.publication.legacy.resolveUniqueLegacyName("function", "same"),
      "ambiguous-legacy-name",
    );
    expect(forward.publication.legacy.internalWasmName(forward.ids.first)).not.toBe(
      forward.publication.legacy.internalWasmName(forward.ids.second),
    );
  });

  it("tracks derived lifted and clone units through explicit parent provenance in any queue order", () => {
    const fixture = sessionFixture();
    const firstRecord = fixture.inventory.allUnits.find((unit) => unit.id === fixture.firstUnitId)!;
    const secondRecord = fixture.inventory.allUnits.find((unit) => unit.id === fixture.secondUnitId)!;
    const liftedFirst = createDerivedIrUnitId({
      parentId: fixture.firstUnitId,
      role: "lifted-closure",
      ordinal: 0,
    });
    const liftedSecond = createDerivedIrUnitId({
      parentId: fixture.secondUnitId,
      role: "lifted-closure",
      ordinal: 0,
    });
    const cloneFirst = createDerivedIrUnitId({
      parentId: liftedFirst,
      role: "monomorphization-clone",
      ordinal: 2,
    });
    const records: ProgramAbiDerivedUnitRecord[] = [
      {
        id: liftedFirst,
        parentId: fixture.firstUnitId,
        terminalOwnerId: firstRecord.terminalOwnerId,
        sourceId: fixture.sourceId,
        role: "lifted-closure",
        ordinal: 0,
      },
      {
        id: liftedSecond,
        parentId: fixture.secondUnitId,
        terminalOwnerId: secondRecord.terminalOwnerId,
        sourceId: fixture.sourceId,
        role: "lifted-closure",
        ordinal: 0,
      },
      {
        id: cloneFirst,
        parentId: liftedFirst,
        terminalOwnerId: firstRecord.terminalOwnerId,
        sourceId: fixture.sourceId,
        role: "monomorphization-clone",
        ordinal: 2,
      },
    ];
    const module = createEmptyModule();
    module.types.push(functionType("$void"));
    const functions = [wasmFunction("lifted"), wasmFunction("lifted"), wasmFunction("clone")];
    module.functions.push(...functions);
    const ids = [
      binding(fixture, "callable", "body", liftedFirst),
      binding(fixture, "callable", "body", liftedSecond),
      binding(fixture, "callable", "body", cloneFirst),
    ];
    const session = new ProgramAbiSession(fixture.inventory, module);
    for (const record of [...records].reverse()) session.registerDerivedUnit(record);
    session.plan(callableDraft(fixture, ids[2]!, cloneFirst, "clone", 0, 0, 2));
    session.plan(callableDraft(fixture, ids[1]!, liftedSecond, "lifted", 0, 0, 1));
    session.plan(callableDraft(fixture, ids[0]!, liftedFirst, "lifted", 0, 0, 0));
    ids.forEach((id, index) => session.attachLocator(id, { kind: "defined-function", value: functions[index]! }));

    const { abi } = session.publish(module);
    expect(ids.map((id) => abi.resolveFinalIndex(id)?.index)).toEqual([0, 1, 2]);
    expect(abi.entries().map((entry) => entry.id)).toEqual(ids);
  });

  it("resolves imported and defined slots after late function/global import shifts", () => {
    const fixture = sessionFixture();
    const module = createEmptyModule();
    module.types.push(functionType("$void"));
    const definedFn = wasmFunction("same");
    const definedGlobal = wasmGlobal("same");
    module.functions.push(definedFn);
    module.globals.push(definedGlobal);

    const definedFnId = binding(fixture, "callable", "defined", fixture.firstUnitId);
    const importFnId = binding(fixture, "callable", "import");
    const definedGlobalId = binding(fixture, "global", "defined");
    const importGlobalId = binding(fixture, "global", "import");
    const session = new ProgramAbiSession(fixture.inventory, module);
    session.plan(callableDraft(fixture, definedFnId, fixture.firstUnitId, "same", 0));
    session.plan({
      id: importFnId,
      structuralOrder: structuralOrder(fixture, "callable", 1),
      displayName: "same",
      slotPolicy: "required",
      slotSpace: "function",
      intent: { kind: "callable", origin: "import", signature: VOID_SIGNATURE },
    });
    session.plan(globalDraft(fixture, definedGlobalId, "same", 2));
    session.plan({
      id: importGlobalId,
      structuralOrder: structuralOrder(fixture, "global", 3),
      displayName: "same",
      slotPolicy: "required",
      slotSpace: "global",
      intent: {
        kind: "global",
        origin: "import",
        valueType: "i32",
        mutable: true,
      },
    });
    session.attachLocator(definedFnId, { kind: "defined-function", value: definedFn });
    session.attachLocator(definedGlobalId, { kind: "defined-global", value: definedGlobal });

    const globalImport: Import = {
      module: "env",
      name: "same",
      desc: { kind: "global", type: { kind: "i32" }, mutable: true },
    };
    const functionImport: Import = {
      module: "env",
      name: "same",
      desc: { kind: "func", typeIdx: 0 },
    };
    module.imports.push(globalImport, functionImport);
    session.attachLocator(importFnId, { kind: "import-function", value: functionImport });
    session.attachLocator(importGlobalId, { kind: "import-global", value: globalImport });

    const { abi } = session.publish(module);
    expect(abi.resolveFinalIndex(importFnId)).toEqual({ space: "function", index: 0 });
    expect(abi.resolveFinalIndex(definedFnId)).toEqual({ space: "function", index: 1 });
    expect(abi.resolveFinalIndex(importGlobalId)).toEqual({ space: "global", index: 0 });
    expect(abi.resolveFinalIndex(definedGlobalId)).toEqual({ space: "global", index: 1 });
  });

  it("follows an explicit type-cell remap through type compaction", () => {
    const fixture = sessionFixture();
    const module = createEmptyModule();
    const removed: TypeDef = { kind: "struct", name: "$Removed", fields: [] };
    const original: TypeDef = { kind: "struct", name: "$Record", fields: [] };
    module.types.push(removed, original);
    const id = binding(fixture, "type", "record");
    const session = new ProgramAbiSession(fixture.inventory, module);
    session.plan(typeDraft(fixture, id, "Record", 0));
    const cell = session.createTypeCell(original);
    session.attachLocator(id, { kind: "type-cell", cell });

    const compacted: TypeDef = { ...original, fields: [] };
    module.types.splice(0, module.types.length, compacted);
    session.remapTypeCell(cell, compacted);
    expect(session.publish(module).abi.resolveFinalIndex(id)).toEqual({ space: "type", index: 0 });
  });

  it("rejects duplicate/invalid drafts and structural-order ties before publish", () => {
    const fixture = sessionFixture();
    const module = createEmptyModule();
    const session = new ProgramAbiSession(fixture.inventory, module);
    const first = binding(fixture, "callable", "first", fixture.firstUnitId);
    const second = binding(fixture, "callable", "second", fixture.secondUnitId);
    const draft = callableDraft(fixture, first, fixture.firstUnitId, "first", 0);
    session.plan(draft);
    expectInvariant(() => session.plan(draft), "duplicate-session-draft");
    expectInvariant(
      () => session.plan(callableDraft(fixture, second, fixture.secondUnitId, "second", 0)),
      "duplicate-draft-order",
    );

    const badOrder = new ProgramAbiSession(fixture.inventory, module);
    expectInvariant(
      () =>
        badOrder.plan({
          ...draft,
          structuralOrder: { ...draft.structuralOrder, domainOrdinal: 99 },
        }),
      "invalid-draft-order",
    );

    const foreign = sessionFixture("/other/foreign.ts");
    const unknownSource = new ProgramAbiSession(fixture.inventory, module);
    expectInvariant(
      () =>
        unknownSource.plan({
          ...draft,
          structuralOrder: { ...draft.structuralOrder, sourceId: foreign.sourceId },
        }),
      "unknown-draft-source",
    );
  });

  it("rejects unknown, duplicate, non-required, reused, foreign, and wrong-space locators", () => {
    const fixture = sessionFixture();
    const module = createEmptyModule();
    const fn = wasmFunction("same");
    const global = wasmGlobal("same");
    const first = binding(fixture, "callable", "first", fixture.firstUnitId);
    const second = binding(fixture, "callable", "second", fixture.secondUnitId);
    const alias = binding(fixture, "callable", "alias");
    const unknown = binding(fixture, "callable", "unknown");
    const session = new ProgramAbiSession(fixture.inventory, module);
    session.plan(callableDraft(fixture, first, fixture.firstUnitId, "first", 0));
    session.plan(callableDraft(fixture, second, fixture.secondUnitId, "second", 1));
    session.plan(callableAliasDraft(fixture, alias, first, "alias", 2));

    expectInvariant(
      () => session.attachLocator(unknown, { kind: "defined-function", value: fn }),
      "unknown-locator-binding",
    );
    expectInvariant(
      () => session.attachLocator(alias, { kind: "defined-function", value: fn }),
      "locator-not-required",
    );
    expectInvariant(
      () => session.attachLocator(first, { kind: "defined-global", value: global }),
      "slot-locator-space-mismatch",
    );
    session.attachLocator(first, { kind: "defined-function", value: fn });
    expectInvariant(
      () => session.attachLocator(first, { kind: "defined-function", value: wasmFunction("other") }),
      "duplicate-slot-locator",
    );
    expectInvariant(
      () => session.attachLocator(second, { kind: "defined-function", value: fn }),
      "duplicate-slot-locator",
    );

    const typeId = binding(fixture, "type", "record");
    const otherTypeId = binding(fixture, "type", "other");
    const typeSession = new ProgramAbiSession(fixture.inventory, module);
    const otherSession = new ProgramAbiSession(fixture.inventory, module);
    typeSession.plan(typeDraft(fixture, typeId, "Record", 0));
    typeSession.plan({
      ...typeDraft(fixture, otherTypeId, "Other", 1),
      structuralOrder: structuralOrder(fixture, "type", 1),
    });
    const foreignCell = otherSession.createTypeCell({ kind: "struct", name: "$Foreign", fields: [] });
    expectInvariant(
      () => typeSession.attachLocator(typeId, { kind: "type-cell", cell: foreignCell }),
      "foreign-type-cell",
    );
    expectInvariant(() => typeSession.remapTypeCell(foreignCell, null), "foreign-type-cell");
  });

  it("rejects missing and eliminated required locators without a second publish attempt", () => {
    const fixture = sessionFixture();
    const missingModule = createEmptyModule();
    const missingId = binding(fixture, "callable", "missing", fixture.firstUnitId);
    const missing = new ProgramAbiSession(fixture.inventory, missingModule);
    missing.plan(callableDraft(fixture, missingId, fixture.firstUnitId, "missing", 0));
    expectInvariant(() => missing.publish(missingModule), "missing-required-locator");
    expectInvariant(() => missing.publish(missingModule), "session-publish-once");

    const removedModule = createEmptyModule();
    const removedFn = wasmFunction("removed");
    const removedId = binding(fixture, "callable", "removed", fixture.firstUnitId);
    const removed = new ProgramAbiSession(fixture.inventory, removedModule);
    removed.plan(callableDraft(fixture, removedId, fixture.firstUnitId, "removed", 0));
    removed.attachLocator(removedId, { kind: "defined-function", value: removedFn });
    expectInvariant(() => removed.publish(removedModule), "eliminated-required-locator");

    const typeModule = createEmptyModule();
    const typeId = binding(fixture, "type", "removed");
    const eliminatedType = new ProgramAbiSession(fixture.inventory, typeModule);
    eliminatedType.plan(typeDraft(fixture, typeId, "Removed", 0));
    const cell = eliminatedType.createTypeCell({ kind: "struct", name: "$Removed", fields: [] });
    eliminatedType.attachLocator(typeId, { kind: "type-cell", cell });
    eliminatedType.remapTypeCell(cell, null);
    expectInvariant(() => eliminatedType.publish(typeModule), "eliminated-required-locator");
  });

  it("closes planning after publish, rejects publish twice, and validates context ownership", () => {
    const fixture = sessionFixture();
    const module = createEmptyModule();
    const support = binding(fixture, "support", "marker");
    const session = new ProgramAbiSession(fixture.inventory, module);
    session.plan(supportDraft(fixture, support, 0));
    const publication = session.publish(module);
    expect(session.publication).toBe(publication);
    expectInvariant(
      () => session.plan(supportDraft(fixture, binding(fixture, "support", "late"), 1)),
      "session-closed",
    );
    expectInvariant(() => session.publish(module), "session-publish-once");

    const otherModule = createEmptyModule();
    const mismatch = new ProgramAbiSession(fixture.inventory, module);
    expectInvariant(() => mismatch.assertModule(otherModule), "context-session-mismatch");
    expectInvariant(
      () => createCodegenContext(otherModule, {} as unknown as ts.TypeChecker, undefined, mismatch),
      "context-session-mismatch",
    );
    const matchingContext = createCodegenContext(module, {} as unknown as ts.TypeChecker, undefined, mismatch);
    expect(matchingContext.programAbiSession).toBe(mismatch);
  });
});

describe("#3520 ProgramAbiMap derived-unit provenance", () => {
  function baseDerivedRecord(
    fixture: SessionFixture,
    parentId: IrUnitId,
    role: "lifted-closure" | "monomorphization-clone",
    ordinal: number,
  ): ProgramAbiDerivedUnitRecord {
    const parent = fixture.inventory.allUnits.find((unit) => unit.id === parentId)!;
    return {
      id: createDerivedIrUnitId({ parentId, role, ordinal }),
      parentId,
      terminalOwnerId: parent.terminalOwnerId,
      sourceId: fixture.sourceId,
      role,
      ordinal,
    };
  }

  it("rejects invalid IDs, duplicate units, unknown parents/sources/owners, and ownership mismatches", () => {
    const fixture = sessionFixture();
    const valid = baseDerivedRecord(fixture, fixture.firstUnitId, "lifted-closure", 0);
    expectInvariant(() => new ProgramAbiMap(fixture.inventory, [valid, valid]), "duplicate-derived-unit");
    expectInvariant(
      () => new ProgramAbiMap(fixture.inventory, [{ ...valid, id: "not-the-derived-id" as IrUnitId }]),
      "invalid-derived-unit",
    );

    const unknownParent = "ir-unit:v1:unknown" as IrUnitId;
    const unknownParentRecord: ProgramAbiDerivedUnitRecord = {
      ...valid,
      id: createDerivedIrUnitId({ parentId: unknownParent, role: "lifted-closure", ordinal: 0 }),
      parentId: unknownParent,
    };
    expectInvariant(() => new ProgramAbiMap(fixture.inventory, [unknownParentRecord]), "unknown-derived-parent");

    const foreign = sessionFixture("/other/foreign.ts");
    expectInvariant(
      () => new ProgramAbiMap(fixture.inventory, [{ ...valid, sourceId: foreign.sourceId }]),
      "unknown-derived-source",
    );
    expectInvariant(
      () =>
        new ProgramAbiMap(fixture.inventory, [
          { ...valid, terminalOwnerId: "ir-unit:v1:missing-terminal" as IrUnitId },
        ]),
      "unknown-derived-terminal-owner",
    );
    const second = fixture.inventory.allUnits.find((unit) => unit.id === fixture.secondUnitId)!;
    expectInvariant(
      () => new ProgramAbiMap(fixture.inventory, [{ ...valid, terminalOwnerId: second.terminalOwnerId }]),
      "derived-terminal-owner-mismatch",
    );
  });

  it("rejects a known but different source from the parent", () => {
    const firstFile = source("/repo/a.ts", "export function first() {}");
    const secondFile = source("/repo/b.ts", "export function second() {}");
    const inventory = buildIrUnitInventory([firstFile, secondFile], { entrySource: firstFile });
    const parent = inventory.allUnits.find(
      (unit) => unit.kind === "top-level-function" && unit.displayName === "first",
    )!;
    const otherSource = inventory.sources.find((record) => record.id !== parent.sourceId)!;
    const record: ProgramAbiDerivedUnitRecord = {
      id: createDerivedIrUnitId({ parentId: parent.id, role: "lifted-closure", ordinal: 0 }),
      parentId: parent.id,
      terminalOwnerId: parent.terminalOwnerId,
      sourceId: otherSource.id,
      role: "lifted-closure",
      ordinal: 0,
    };
    expectInvariant(() => new ProgramAbiMap(inventory, [record]), "derived-source-mismatch");
  });
});
