// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import {
  ProgramAbiSession,
  type ProgramAbiDraft,
  type SealedPreparedProgramAbiScope,
} from "../src/codegen/program-abi-session.js";
import { canonicalProgramAbiCallableTypeContract } from "../src/codegen/program-abi-signatures.js";
import {
  buildIrUnitInventory,
  createDerivedIrUnitId,
  createIrBindingId,
  type IrBindingId,
  type IrSourceId,
  type IrUnitId,
} from "../src/ir/identity.js";
import {
  ProgramAbiInvariantError,
  type ProgramAbiDerivedUnitRecord,
  type ProgramAbiInvariantCode,
} from "../src/ir/program-abi.js";
import { createEmptyModule, type WasmFunction, type WasmModule } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

const VOID_SIGNATURE = Object.freeze({
  params: Object.freeze([]),
  results: Object.freeze([]),
});

interface Fixture {
  readonly sourceId: IrSourceId;
  readonly firstUnitId: IrUnitId;
  readonly secondUnitId: IrUnitId;
  readonly module: WasmModule;
  readonly session: ProgramAbiSession;
}

interface PlannedCallable {
  readonly id: IrBindingId;
  readonly func: WasmFunction;
  readonly referenceKey: string;
}

function fixture(): Fixture {
  const sourceFile = ts.createSourceFile(
    "/repo/scoped-prepared-abi.ts",
    "export function first(): void {} function second(): void {}",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inventory = buildIrUnitInventory([sourceFile], { entrySource: sourceFile });
  const first = inventory.terminalUnits.find(
    (unit) => unit.kind === "top-level-function" && unit.displayName === "first",
  );
  const second = inventory.terminalUnits.find(
    (unit) => unit.kind === "top-level-function" && unit.displayName === "second",
  );
  if (!first || !second) throw new Error("invalid scoped ABI fixture");
  const module = createEmptyModule();
  module.types.push({ kind: "func", name: "$void", params: [], results: [] });
  return {
    sourceId: inventory.sources[0]!.id,
    firstUnitId: first.id,
    secondUnitId: second.id,
    module,
    session: new ProgramAbiSession(inventory, module),
  };
}

function callableDraft(
  session: ProgramAbiSession,
  id: IrBindingId,
  unitId: IrUnitId,
  displayName: string,
  referenceKey: string,
): ProgramAbiDraft {
  return {
    id,
    structuralOrder: session.structuralOrder.forUnit(unitId, {
      domain: "callable",
      roleOrdinal: 0,
    }),
    displayName,
    structuralReferenceKey: referenceKey,
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

function planCallable(f: Fixture, unitId: IrUnitId, role: string, displayName: string): PlannedCallable {
  const id = createIrBindingId({ ownerId: unitId, domain: "callable", role });
  const referenceKey = `unit|${unitId}|${role}`;
  const func: WasmFunction = {
    name: displayName,
    typeIdx: 0,
    locals: [],
    body: [],
    exported: false,
  };
  f.module.functions.push(func);
  f.session.plan(callableDraft(f.session, id, unitId, displayName, referenceKey));
  f.session.registerCallableTypeContract(id, VOID_SIGNATURE);
  f.session.registerStructuralReference(id, referenceKey);
  f.session.attachLocator(id, { kind: "defined-function", value: func });
  return { id, func, referenceKey };
}

function supportDraft(session: ProgramAbiSession, id: IrBindingId, unitId: IrUnitId, roleOrdinal = 0): ProgramAbiDraft {
  return {
    id,
    structuralOrder: session.structuralOrder.forUnit(unitId, {
      domain: "support",
      roleOrdinal,
    }),
    displayName: "prepared-support",
    slotPolicy: "none",
    intent: { kind: "support", role: "prepared-support" },
  };
}

function aliasDraft(f: Fixture, id: IrBindingId, targetId: IrBindingId): ProgramAbiDraft {
  return {
    id,
    structuralOrder: f.session.structuralOrder.forSource(f.sourceId, {
      domain: "callable",
      roleOrdinal: 0,
    }),
    displayName: "first-alias",
    slotPolicy: "alias",
    aliasOf: targetId,
    intent: {
      kind: "callable",
      origin: "import",
      signature: VOID_SIGNATURE,
    },
  };
}

function exportDraft(f: Fixture, id: IrBindingId, targetId: IrBindingId): ProgramAbiDraft {
  return {
    id,
    structuralOrder: f.session.structuralOrder.forSource(f.sourceId, {
      domain: "export",
      roleOrdinal: 0,
    }),
    displayName: "first",
    slotPolicy: "alias",
    aliasOf: targetId,
    intent: {
      kind: "export",
      externalName: "first",
      targetId,
    },
  };
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

function sealFirst(f: Fixture, dependencies: readonly IrBindingId[] = []): SealedPreparedProgramAbiScope {
  const transaction = f.session.beginPreparedComponentScope("first-component", [f.firstUnitId]);
  for (const id of dependencies) transaction.includeBinding(id);
  return transaction.seal();
}

describe("#3521 scoped prepared-component ABI seal", () => {
  it("pins callable, derived, alias, export, and support closure while unrelated direct planning remains legal", () => {
    const f = fixture();
    const first = planCallable(f, f.firstUnitId, "body", "first");
    const derivedUnitId = createDerivedIrUnitId({
      parentId: f.firstUnitId,
      role: "monomorphized-clone",
      ordinal: 0,
    });
    const derivedRecord: ProgramAbiDerivedUnitRecord = {
      id: derivedUnitId,
      parentId: f.firstUnitId,
      terminalOwnerId: f.firstUnitId,
      sourceId: f.sourceId,
      role: "monomorphized-clone",
      ordinal: 0,
    };
    f.session.registerDerivedUnit(derivedRecord);
    const clone = planCallable(f, derivedUnitId, "body", "first$mono0");
    const aliasId = createIrBindingId({ ownerId: f.sourceId, domain: "callable", role: "first-alias" });
    const exportId = createIrBindingId({ ownerId: f.sourceId, domain: "export", role: "first" });
    const supportId = createIrBindingId({ ownerId: f.firstUnitId, domain: "support", role: "string-table" });
    f.session.plan(aliasDraft(f, aliasId, first.id));
    f.session.plan(exportDraft(f, exportId, first.id));
    f.session.plan(supportDraft(f.session, supportId, f.firstUnitId));

    const scoped = sealFirst(f, [supportId]);
    expect(scoped.planningSealed).toBe(true);
    expect(scoped.terminalUnitIds).toEqual([f.firstUnitId]);
    expect(scoped.derivedUnits).toEqual([derivedRecord]);
    expect(new Set(scoped.bindingIds)).toEqual(new Set([first.id, clone.id, aliasId, exportId, supportId]));
    expect(scoped.canonicalId(aliasId)).toBe(first.id);
    expect(scoped.canonicalId(exportId)).toBe(first.id);
    expect(scoped.entries().map((entry) => entry.id)).toEqual(scoped.bindingIds);

    const second = planCallable(f, f.secondUnitId, "body", "second");
    const unrelatedSupportId = createIrBindingId({
      ownerId: f.secondUnitId,
      domain: "support",
      role: "direct-only",
    });
    f.session.plan(supportDraft(f.session, unrelatedSupportId, f.secondUnitId));

    const publication = f.session.publish(f.module);
    expect(publication.abi.resolveFinalIndex(first.id)).toEqual({ space: "function", index: 0 });
    expect(publication.abi.resolveFinalIndex(clone.id)).toEqual({ space: "function", index: 1 });
    expect(publication.abi.resolveFinalIndex(second.id)).toEqual({ space: "function", index: 2 });
    expect(scoped.entries().map((entry) => entry.id)).toEqual(scoped.bindingIds);
  });

  it("rejects missing reservations and locators atomically, then permits a corrected scope", () => {
    const missingLocator = fixture();
    const locatorId = createIrBindingId({
      ownerId: missingLocator.firstUnitId,
      domain: "callable",
      role: "body",
    });
    const locatorKey = `unit|${missingLocator.firstUnitId}|body`;
    missingLocator.session.plan(
      callableDraft(missingLocator.session, locatorId, missingLocator.firstUnitId, "first", locatorKey),
    );
    missingLocator.session.registerCallableTypeContract(locatorId, VOID_SIGNATURE);
    missingLocator.session.registerStructuralReference(locatorId, locatorKey);
    const failedLocator = missingLocator.session.beginPreparedComponentScope("missing-locator", [
      missingLocator.firstUnitId,
    ]);
    expectInvariant(() => failedLocator.seal(), "missing-required-locator");
    expectInvariant(() => failedLocator.includeBinding(locatorId), "session-closed");

    const locator: WasmFunction = {
      name: "first",
      typeIdx: 0,
      locals: [],
      body: [],
      exported: false,
    };
    missingLocator.module.functions.push(locator);
    missingLocator.session.attachLocator(locatorId, { kind: "defined-function", value: locator });
    const corrected = missingLocator.session.beginPreparedComponentScope("corrected", [missingLocator.firstUnitId]);
    expect(corrected.seal().bindingIds).toEqual([locatorId]);

    const missingReference = fixture();
    const unreservedId = createIrBindingId({
      ownerId: missingReference.firstUnitId,
      domain: "callable",
      role: "body",
    });
    const unreservedKey = `unit|${missingReference.firstUnitId}|body`;
    const unreservedFunc: WasmFunction = {
      name: "first",
      typeIdx: 0,
      locals: [],
      body: [],
      exported: false,
    };
    missingReference.module.functions.push(unreservedFunc);
    missingReference.session.plan(
      callableDraft(missingReference.session, unreservedId, missingReference.firstUnitId, "first", unreservedKey),
    );
    missingReference.session.registerCallableTypeContract(unreservedId, VOID_SIGNATURE);
    missingReference.session.attachLocator(unreservedId, {
      kind: "defined-function",
      value: unreservedFunc,
    });
    const failedReference = missingReference.session.beginPreparedComponentScope("missing-reference", [
      missingReference.firstUnitId,
    ]);
    expectInvariant(() => failedReference.seal(), "missing-binding-reference");
  });

  it("rejects prepared-owned late support, derived units, and locator replacement but accepts unrelated support", () => {
    const f = fixture();
    const first = planCallable(f, f.firstUnitId, "body", "first");
    sealFirst(f);

    const lateSupportId = createIrBindingId({
      ownerId: f.firstUnitId,
      domain: "support",
      role: "late-helper",
    });
    expectInvariant(() => f.session.plan(supportDraft(f.session, lateSupportId, f.firstUnitId)), "planning-sealed");
    expectInvariant(
      () =>
        f.session.registerDerivedUnit({
          id: createDerivedIrUnitId({
            parentId: f.firstUnitId,
            role: "lifted-closure",
            ordinal: 0,
          }),
          parentId: f.firstUnitId,
          terminalOwnerId: f.firstUnitId,
          sourceId: f.sourceId,
          role: "lifted-closure",
          ordinal: 0,
        }),
      "planning-sealed",
    );
    expectInvariant(
      () =>
        f.session.replaceDefinedFunctionLocator(first.id, first.func, {
          ...first.func,
          name: "replacement",
        }),
      "locator-remap-mismatch",
    );

    const unrelatedSupportId = createIrBindingId({
      ownerId: f.secondUnitId,
      domain: "support",
      role: "late-direct-helper",
    });
    f.session.plan(supportDraft(f.session, unrelatedSupportId, f.secondUnitId));
    expect(f.session.publish(f.module).abi.resolveFinalIndex(first.id)).toEqual({
      space: "function",
      index: 0,
    });
  });

  it("fails closed when the reserved callable contract drifts before final reconciliation", () => {
    const f = fixture();
    const first = planCallable(f, f.firstUnitId, "body", "first");
    sealFirst(f);
    f.module.types.push({ kind: "func", name: "$i32", params: [{ kind: "i32" }], results: [] });
    first.func.typeIdx = 1;

    expectInvariant(() => f.session.publish(f.module), "type-remap-mismatch");
    expectInvariant(() => f.session.publish(f.module), "session-publish-once");
  });

  it("advances pinned structured contracts only through an explicit type-layout remap", () => {
    const f = fixture();
    const previousTypes = [
      { kind: "struct" as const, name: "$Payload", fields: [] },
      {
        kind: "func" as const,
        name: "$consume",
        params: [{ kind: "ref" as const, typeIdx: 0 }],
        results: [],
      },
    ];
    f.module.types = previousTypes;
    const contract = Object.freeze({
      params: Object.freeze([{ kind: "ref" as const, typeIdx: 0 }]),
      results: Object.freeze([]),
    });
    const id = createIrBindingId({ ownerId: f.firstUnitId, domain: "callable", role: "body" });
    const referenceKey = `unit|${f.firstUnitId}|body`;
    const func: WasmFunction = {
      name: "first",
      typeIdx: 1,
      locals: [],
      body: [],
      exported: false,
    };
    f.module.functions.push(func);
    f.session.plan({
      ...callableDraft(f.session, id, f.firstUnitId, "first", referenceKey),
      intent: {
        kind: "callable",
        origin: "source",
        signature: canonicalProgramAbiCallableTypeContract(contract),
        unitId: f.firstUnitId,
      },
    });
    f.session.registerCallableTypeContract(id, contract);
    f.session.registerStructuralReference(id, referenceKey);
    f.session.attachLocator(id, { kind: "defined-function", value: func });
    sealFirst(f);

    const nextTypes = [
      {
        kind: "func" as const,
        name: "$consume",
        params: [{ kind: "ref" as const, typeIdx: 1 }],
        results: [],
      },
      { kind: "struct" as const, name: "$Payload", fields: [] },
    ];
    f.session.applyTypeLayoutRemap({
      previousTypes,
      nextTypes,
      targetsByOldIndex: [1, 0],
    });
    f.module.types = nextTypes;
    func.typeIdx = 0;

    expect(f.session.publish(f.module).abi.resolveFinalIndex(id)).toEqual({
      space: "function",
      index: 0,
    });
  });

  it("aborts discovery without publishing a partial scope or closing unrelated planning", () => {
    const f = fixture();
    planCallable(f, f.firstUnitId, "body", "first");
    const unknownSupportId = createIrBindingId({
      ownerId: f.firstUnitId,
      domain: "support",
      role: "not-yet-planned",
    });
    const failed = f.session.beginPreparedComponentScope("failed-discovery", [f.firstUnitId]);
    failed.includeBinding(unknownSupportId);
    expectInvariant(() => failed.seal(), "unknown-binding");
    expectInvariant(() => failed.abort(), "session-closed");

    f.session.plan(supportDraft(f.session, unknownSupportId, f.firstUnitId));
    const retry = f.session.beginPreparedComponentScope("retry", [f.firstUnitId]);
    retry.includeBinding(unknownSupportId);
    expect(retry.seal().bindingIds).toContain(unknownSupportId);
    expect(f.session.publish(f.module).abi.get(unknownSupportId)?.intent).toEqual({
      kind: "support",
      role: "prepared-support",
    });
  });

  it("requires open scope transactions to abort or seal before whole-program sealing", () => {
    const f = fixture();
    planCallable(f, f.firstUnitId, "body", "first");
    const transaction = f.session.beginPreparedComponentScope("open", [f.firstUnitId]);
    expectInvariant(() => f.session.sealPlan(f.module), "planning-not-sealed");
    transaction.abort();
    expect(f.session.publish(f.module).abi.entries()).toHaveLength(1);
  });
});
