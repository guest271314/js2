// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import {
  canonicalProgramAbiCallableTypeContract,
  canonicalProgramAbiValType,
} from "../src/codegen/program-abi-signatures.js";
import { ProgramAbiSession, type ProgramAbiDraft } from "../src/codegen/program-abi-session.js";
import {
  buildIrUnitInventory,
  createDerivedIrUnitId,
  createIrBindingId,
  type IrBindingId,
} from "../src/ir/identity.js";
import { ProgramAbiInvariantError, type ProgramAbiInvariantCode } from "../src/ir/program-abi.js";
import {
  createEmptyModule,
  type FuncTypeDef,
  type GlobalDef,
  type TypeDef,
  type WasmFunction,
} from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

const VOID_SIGNATURE = Object.freeze({
  params: Object.freeze([]),
  results: Object.freeze([]),
});

function expectInvariant(action: () => unknown, code: ProgramAbiInvariantCode): void {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ProgramAbiInvariantError);
  expect((caught as ProgramAbiInvariantError).code).toBe(code);
}

function fixture() {
  const sourceFile = ts.createSourceFile(
    "/repo/session-seal.ts",
    "export function value(): number { return 1; } function other(): number { return 2; }",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inventory = buildIrUnitInventory([sourceFile], { entrySource: sourceFile });
  const unit = inventory.allUnits.find(
    (candidate) => candidate.kind === "top-level-function" && candidate.displayName === "value",
  );
  const otherUnit = inventory.allUnits.find(
    (candidate) => candidate.kind === "top-level-function" && candidate.displayName === "other",
  );
  if (!unit || !otherUnit) throw new Error("missing function inventory unit");
  return { inventory, sourceId: inventory.sources[0]!.id, unit, otherUnit };
}

function functionDraft(
  session: ProgramAbiSession,
  id: IrBindingId,
  unitId: ReturnType<typeof fixture>["unit"]["id"],
  structuralReferenceKey: string,
): ProgramAbiDraft {
  return {
    id,
    structuralOrder: session.structuralOrder.forUnit(unitId, {
      domain: "callable",
      roleOrdinal: 0,
    }),
    displayName: "value",
    structuralReferenceKey,
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

function wasmFunction(name: string): WasmFunction {
  return { name, typeIdx: 0, locals: [], body: [], exported: false };
}

describe("#3521 Program ABI plan sealing", () => {
  it("seals intentions before exact replacement and binds the final shifted function index once", () => {
    const { inventory, sourceId, unit } = fixture();
    const module = createEmptyModule();
    module.types.push({ kind: "func", name: "$void", params: [], results: [] });
    const original = wasmFunction("value$planned");
    module.functions.push(original);

    const session = new ProgramAbiSession(inventory, module);
    const bindingId = createIrBindingId({ ownerId: unit.id, domain: "callable", role: "body" });
    const referenceKey = `unit|${unit.id}|body`;
    session.plan(functionDraft(session, bindingId, unit.id, referenceKey));
    session.registerCallableTypeContract(bindingId, VOID_SIGNATURE);
    session.attachLocator(bindingId, { kind: "defined-function", value: original });

    const sealed = session.sealPlan(module);
    expect(sealed.planningSealed).toBe(true);
    expect(session.sealPlan(module)).toBe(sealed);
    expect("bindFinalIndex" in sealed).toBe(false);
    expect("finishBinding" in sealed).toBe(false);
    expect(() =>
      (
        sealed as typeof sealed & {
          bindFinalIndex(id: IrBindingId, value: { space: "function"; index: number }): void;
        }
      ).bindFinalIndex(bindingId, { space: "function", index: 99 }),
    ).toThrow(TypeError);
    const sealedEntry = sealed.get(bindingId)!;
    expect(Object.isFrozen(sealedEntry)).toBe(true);
    expect(Reflect.set(sealedEntry, "displayName", "tampered")).toBe(false);

    const lateBinding = createIrBindingId({ ownerId: sourceId, domain: "support", role: "late" });
    expectInvariant(
      () =>
        session.plan({
          id: lateBinding,
          structuralOrder: session.structuralOrder.forSource(sourceId, {
            domain: "support",
            roleOrdinal: 0,
          }),
          displayName: "late",
          slotPolicy: "none",
          intent: { kind: "support", role: "late" },
        }),
      "session-closed",
    );
    expectInvariant(
      () => session.ensurePlan(functionDraft(session, bindingId, unit.id, referenceKey)),
      "session-closed",
    );
    expectInvariant(() => session.registerStructuralReference(bindingId, referenceKey), "session-closed");
    const derivedId = createDerivedIrUnitId({
      parentId: unit.id,
      role: "lifted-closure",
      ordinal: 0,
    });
    expectInvariant(
      () =>
        session.registerDerivedUnit({
          id: derivedId,
          parentId: unit.id,
          terminalOwnerId: unit.terminalOwnerId,
          sourceId: unit.sourceId,
          role: "lifted-closure",
          ordinal: 0,
        }),
      "session-closed",
    );
    expectInvariant(() => session.registerCallableTypeContract(bindingId, VOID_SIGNATURE), "session-closed");
    expectInvariant(() => session.createTypeCell({ kind: "struct", name: "$Late", fields: [] }), "session-closed");
    expectInvariant(
      () => session.attachLocator(bindingId, { kind: "defined-function", value: original }),
      "session-closed",
    );

    const replacement = wasmFunction("value$emitted");
    module.functions[0] = replacement;
    session.replaceDefinedFunctionLocator(bindingId, original, replacement);

    module.imports.push({
      module: "env",
      name: "late_import",
      desc: { kind: "func", typeIdx: 0 },
    });
    expect(session.resolveCurrentIndex(bindingId, "function", referenceKey, module)).toBe(1);

    const publication = session.bindAndPublish(module);
    expect(publication.abi).not.toBe(sealed);
    expect(publication.abi.resolveFinalIndex(bindingId)).toEqual({ space: "function", index: 1 });
    expect(session.publication).toBe(publication);
    expect(session.resolveCurrentIndex(bindingId, "function", referenceKey, module)).toBe(1);
    expectInvariant(
      () => session.replaceDefinedFunctionLocator(bindingId, replacement, wasmFunction("post-publish")),
      "session-closed",
    );
    expectInvariant(
      () => session.remapTypeObject(module.types[0]!, { kind: "func", name: "$other", params: [], results: [] }),
      "session-closed",
    );
    expectInvariant(() => session.bindAndPublish(module), "session-publish-once");
    expectInvariant(() => session.publish(module), "session-publish-once");
  });

  it("allows an exact type-cell DCE remap after sealing and binds only the retained object", () => {
    const { inventory, sourceId } = fixture();
    const module = createEmptyModule();
    const removed: TypeDef = { kind: "struct", name: "$Removed", fields: [] };
    const planned: TypeDef = { kind: "struct", name: "$Record$planned", fields: [] };
    module.types.push(removed, planned);

    const session = new ProgramAbiSession(inventory, module);
    const bindingId = createIrBindingId({ ownerId: sourceId, domain: "type", role: "record" });
    const referenceKey = `type|${bindingId}`;
    session.plan({
      id: bindingId,
      structuralOrder: session.structuralOrder.forSource(sourceId, {
        domain: "type",
        roleOrdinal: 0,
      }),
      displayName: "$Record",
      structuralReferenceKey: referenceKey,
      slotPolicy: "required",
      slotSpace: "type",
      intent: { kind: "type", shapeKey: "struct:record" },
    });
    const cell = session.createTypeCell(planned);
    session.attachLocator(bindingId, { kind: "type-cell", cell });

    const sealed = session.sealPlan(module);
    const retained: TypeDef = { kind: "struct", name: "$Record$retained", fields: [] };
    session.remapTypeCell(cell, retained);
    module.types = [retained];

    expect(session.resolveCurrentIndex(bindingId, "type", referenceKey, module)).toBe(0);
    const publication = session.bindAndPublish(module);
    expect(publication.abi).not.toBe(sealed);
    expect(publication.abi.resolveFinalIndex(bindingId)).toEqual({ space: "type", index: 0 });
  });

  it("re-materializes callable and global type-index contracts after a post-seal layout remap", () => {
    const { inventory, sourceId, unit } = fixture();
    const module = createEmptyModule();
    const removed: TypeDef = { kind: "struct", name: "$Removed", fields: [] };
    const payload: TypeDef = { kind: "struct", name: "$Payload$planned", fields: [] };
    const callableType: FuncTypeDef = {
      kind: "func",
      name: "$callable$planned",
      params: [{ kind: "ref", typeIdx: 1 }],
      results: [{ kind: "ref_null", typeIdx: 1 }],
    };
    module.types.push(removed, payload, callableType);
    const callable = wasmFunction("value$planned");
    callable.typeIdx = 2;
    const global: GlobalDef = {
      name: "state$planned",
      type: { kind: "ref_null", typeIdx: 1 },
      mutable: true,
      init: [{ op: "ref.null", typeIdx: 1 }],
    };
    module.functions.push(callable);
    module.globals.push(global);

    const session = new ProgramAbiSession(inventory, module);
    const callableId = createIrBindingId({ ownerId: unit.id, domain: "callable", role: "body" });
    const globalId = createIrBindingId({ ownerId: sourceId, domain: "global", role: "state" });
    session.plan({
      id: callableId,
      structuralOrder: session.structuralOrder.forUnit(unit.id, {
        domain: "callable",
        roleOrdinal: 0,
      }),
      displayName: "value",
      slotPolicy: "required",
      slotSpace: "function",
      intent: {
        kind: "callable",
        origin: "source",
        signature: canonicalProgramAbiCallableTypeContract(callableType),
        unitId: unit.id,
      },
    });
    session.registerCallableTypeContract(callableId, callableType);
    session.attachLocator(callableId, { kind: "defined-function", value: callable });
    session.plan({
      id: globalId,
      structuralOrder: session.structuralOrder.forSource(sourceId, {
        domain: "global",
        roleOrdinal: 0,
      }),
      displayName: "state",
      slotPolicy: "required",
      slotSpace: "global",
      intent: {
        kind: "global",
        origin: "source",
        valueType: canonicalProgramAbiValType(global.type),
        mutable: true,
      },
    });
    session.registerGlobalTypeContract(globalId, global.type, global.mutable);
    session.attachLocator(globalId, { kind: "defined-global", value: global });

    const sealed = session.sealPlan(module);
    const sealedCallableIntent = sealed.get(callableId)!.intent;
    const sealedGlobalIntent = sealed.get(globalId)!.intent;
    expect(sealedCallableIntent.kind === "callable" ? sealedCallableIntent.signature.params : []).toEqual([
      '{"kind":"ref","typeIdx":1}',
    ]);
    expect(sealedGlobalIntent.kind === "global" ? sealedGlobalIntent.valueType : "").toBe(
      '{"kind":"ref_null","typeIdx":1}',
    );

    const finalPayload: TypeDef = { kind: "struct", name: "$Payload$final", fields: [] };
    const finalCallableType: FuncTypeDef = {
      kind: "func",
      name: "$callable$final",
      params: [{ kind: "ref", typeIdx: 0 }],
      results: [{ kind: "ref_null", typeIdx: 0 }],
    };
    const previousTypes = module.types;
    const nextTypes = [finalPayload, finalCallableType];
    session.applyTypeLayoutRemap({
      previousTypes,
      nextTypes,
      targetsByOldIndex: [null, 0, 1],
    });
    module.types = nextTypes;
    callable.typeIdx = 1;
    global.type = { kind: "ref_null", typeIdx: 0 };
    global.init = [{ op: "ref.null", typeIdx: 0 }];

    const remappedCallableIntent = sealed.get(callableId)!.intent;
    const remappedGlobalIntent = sealed.get(globalId)!.intent;
    expect(remappedCallableIntent.kind === "callable" ? remappedCallableIntent.signature.params : []).toEqual([
      '{"kind":"ref","typeIdx":0}',
    ]);
    expect(remappedGlobalIntent.kind === "global" ? remappedGlobalIntent.valueType : "").toBe(
      '{"kind":"ref_null","typeIdx":0}',
    );

    const publication = session.bindAndPublish(module);
    expect(publication.abi.get(callableId)?.intent).toEqual(remappedCallableIntent);
    expect(publication.abi.get(globalId)?.intent).toEqual(remappedGlobalIntent);
    expect(publication.abi.resolveFinalIndex(callableId)).toEqual({ space: "function", index: 0 });
    expect(publication.abi.resolveFinalIndex(globalId)).toEqual({ space: "global", index: 0 });
  });

  it("rejects unsealed binding and atomically fails a required draft without its planning locator", () => {
    const { inventory, unit } = fixture();
    const module = createEmptyModule();
    module.types.push({ kind: "func", name: "$void", params: [], results: [] });
    const session = new ProgramAbiSession(inventory, module);
    expectInvariant(() => session.bindAndPublish(module), "planning-not-sealed");

    const bindingId = createIrBindingId({ ownerId: unit.id, domain: "callable", role: "body" });
    session.plan(functionDraft(session, bindingId, unit.id, `unit|${unit.id}|body`));
    expectInvariant(() => session.sealPlan(module), "missing-required-locator");
    expect(session.publication).toBeUndefined();
    expectInvariant(
      () => session.attachLocator(bindingId, { kind: "defined-function", value: wasmFunction("late") }),
      "session-closed",
    );
    expectInvariant(() => session.sealPlan(module), "session-closed");
    expectInvariant(() => session.publish(module), "session-publish-once");
  });

  it("validates every final locator before committing any index when a later entry was eliminated", () => {
    const { inventory, unit, otherUnit } = fixture();
    const module = createEmptyModule();
    module.types.push({ kind: "func", name: "$void", params: [], results: [] });
    const first = wasmFunction("first");
    const second = wasmFunction("second");
    module.functions.push(first, second);

    const session = new ProgramAbiSession(inventory, module);
    const firstId = createIrBindingId({ ownerId: unit.id, domain: "callable", role: "body" });
    const secondId = createIrBindingId({ ownerId: otherUnit.id, domain: "callable", role: "body" });
    session.plan(functionDraft(session, firstId, unit.id, `unit|${unit.id}|body`));
    session.plan(functionDraft(session, secondId, otherUnit.id, `unit|${otherUnit.id}|body`));
    session.attachLocator(firstId, { kind: "defined-function", value: first });
    session.attachLocator(secondId, { kind: "defined-function", value: second });
    const sealed = session.sealPlan(module);

    module.functions = [first];
    expectInvariant(() => session.bindAndPublish(module), "eliminated-required-locator");
    expect(session.publication).toBeUndefined();
    expect("resolveFinalIndex" in sealed).toBe(false);
    expectInvariant(() => session.bindAndPublish(module), "session-publish-once");
    expectInvariant(() => session.publish(module), "session-publish-once");
  });
});
