// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { ProgramAbiSession, type ProgramAbiDraft } from "../src/codegen/program-abi-session.js";
import { buildIrUnitInventory, createIrBindingId, type IrBindingId } from "../src/ir/identity.js";
import { ProgramAbiInvariantError, type ProgramAbiInvariantCode } from "../src/ir/program-abi.js";
import { createEmptyModule, type TypeDef, type WasmFunction } from "../src/ir/types.js";
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
    "export function value(): number { return 1; }",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inventory = buildIrUnitInventory([sourceFile], { entrySource: sourceFile });
  const unit = inventory.allUnits.find((candidate) => candidate.kind === "top-level-function");
  if (!unit) throw new Error("missing function inventory unit");
  return { inventory, sourceId: inventory.sources[0]!.id, unit };
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
    expect(sealed.resolveFinalIndex(bindingId)).toBeUndefined();
    expect(session.sealPlan(module)).toBe(sealed);

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
    expect(publication.abi).toBe(sealed);
    expect(publication.abi.resolveFinalIndex(bindingId)).toEqual({ space: "function", index: 1 });
    expect(session.publication).toBe(publication);
    expect(session.resolveCurrentIndex(bindingId, "function", referenceKey, module)).toBe(1);
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
    expect(publication.abi).toBe(sealed);
    expect(publication.abi.resolveFinalIndex(bindingId)).toEqual({ space: "type", index: 0 });
  });
});
