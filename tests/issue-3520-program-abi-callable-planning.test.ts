// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { generateModule } from "../src/codegen/index.js";
import { planProgramAbiUnitCallable } from "../src/codegen/program-abi-planning.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { irCallableBindingKey, irUnitCallableBindingId, irUnitFuncRef } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, createDerivedIrUnitId } from "../src/ir/identity.js";
import { createEmptyModule, type FuncTypeDef, type Import, type WasmFunction } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";

// Register the codegen expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

function source(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function wasmFunction(name: string, typeIdx: number): WasmFunction {
  return { name, typeIdx, locals: [], body: [], exported: false };
}

describe("#3520 production unit-callable Program ABI planning", () => {
  it("keeps same-labelled units distinct and resolves their exact locators after a late import and replacement", () => {
    const firstSource = source("/repo/a.ts", "export function same() {}");
    const secondSource = source("/repo/b.ts", "export function same() {}");
    const inventory = buildIrUnitInventory([secondSource, firstSource], { entrySource: firstSource });
    const units = inventory.allUnits.filter(
      (unit) => unit.kind === "top-level-function" && unit.displayName === "same",
    );
    expect(units).toHaveLength(2);

    const module = createEmptyModule();
    module.types.push({ kind: "struct", name: "$Payload", fields: [] });
    const signature: FuncTypeDef = {
      kind: "func",
      name: "$same",
      params: [
        { kind: "i32", boolean: true },
        { kind: "i32", symbol: true },
        { kind: "i64", bigint: true },
        { kind: "ref_null", typeIdx: 0 },
        { kind: "externref" },
      ],
      results: [{ kind: "ref", typeIdx: 0 }],
    };
    module.types.push(signature);
    const functions = [wasmFunction("same", 1), wasmFunction("same", 1)];
    module.functions.push(...functions);

    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
    const refs = units.map((unit) => irUnitFuncRef({ unitId: unit.id, name: "same" }));
    const ids = refs.map((ref, index) => planProgramAbiUnitCallable(ctx, { ref, signature, func: functions[index]! }));
    expect(ids).toEqual(units.map((unit) => irUnitCallableBindingId(unit.id)));
    expect(new Set(ids).size).toBe(2);

    const firstDraft = session.getDraft(ids[0]!)!;
    expect(firstDraft.intent).toEqual({
      kind: "callable",
      origin: "source",
      unitId: units[0]!.id,
      signature: {
        params: [
          '{"kind":"i32","boolean":true}',
          '{"kind":"i32","symbol":true}',
          '{"kind":"i64","bigint":true}',
          '{"kind":"ref_null","typeIdx":0}',
          '{"kind":"externref"}',
        ],
        results: ['{"kind":"ref","typeIdx":0}'],
      },
    });

    // A misleading compatibility label never redirects the structural binding
    // to the other same-labelled unit.
    const mismatchedName = irUnitFuncRef({ unitId: units[0]!.id, name: "wrong-slot-label" });
    expect(session.resolveCurrentIndex(ids[0]!, "function", irCallableBindingKey(mismatchedName.binding))).toBe(0);

    const lateImport: Import = {
      module: "env",
      name: "late",
      desc: { kind: "func", typeIdx: 1 },
    };
    module.imports.push(lateImport);
    expect(
      ids.map((id, index) => session.resolveCurrentIndex(id!, "function", irCallableBindingKey(refs[index]!.binding))),
    ).toEqual([1, 2]);

    const replacement = { ...functions[0]!, body: [{ op: "unreachable" } as const] };
    module.functions[0] = replacement;
    session.replaceDefinedFunctionLocator(ids[0]!, functions[0]!, replacement);

    const { abi } = session.publish(module);
    expect(ids.map((id) => abi.resolveFinalIndex(id!))).toEqual([
      { space: "function", index: 1 },
      { space: "function", index: 2 },
    ]);
    expect(
      abi
        .entries()
        .filter((entry) => entry.intent.kind === "callable")
        .map((entry) => entry.id),
    ).toEqual(ids);
  });

  it("leaves non-inventory derived units explicitly unplanned without inferring provenance", () => {
    const file = source("/repo/derived.ts", "export function owner() {}");
    const inventory = buildIrUnitInventory([file], { entrySource: file });
    const owner = inventory.allUnits.find((unit) => unit.kind === "top-level-function")!;
    const derivedUnitId = createDerivedIrUnitId({
      parentId: owner.id,
      role: "lifted-closure",
      ordinal: 0,
    });
    const module = createEmptyModule();
    const signature: FuncTypeDef = { kind: "func", params: [], results: [] };
    const derived = wasmFunction("owner__closure_0", 0);
    module.types.push(signature);
    module.functions.push(derived);
    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);

    const id = irUnitCallableBindingId(derivedUnitId);
    expect(
      planProgramAbiUnitCallable(ctx, {
        ref: irUnitFuncRef({ unitId: derivedUnitId, name: derived.name }),
        signature,
        func: derived,
      }),
    ).toBeUndefined();
    expect(session.hasPlan(id)).toBe(false);
    expect(session.hasLocator(id)).toBe(false);

    const noSession = createCodegenContext(module, {} as ts.TypeChecker);
    expect(
      planProgramAbiUnitCallable(noSession, {
        ref: irUnitFuncRef({ unitId: owner.id, name: "owner" }),
        signature,
        func: derived,
      }),
    ).toBeUndefined();
  });

  it("plans explicitly registered lifted units with distinct deterministic suborders", () => {
    const file = source("/repo/lifted.ts", "export function owner() {}");
    const inventory = buildIrUnitInventory([file], { entrySource: file });
    const owner = inventory.allUnits.find((unit) => unit.kind === "top-level-function")!;
    const liftedUnitIds = [0, 1].map((ordinal) =>
      createDerivedIrUnitId({
        parentId: owner.id,
        role: "lifted-closure",
        ordinal,
      }),
    );
    const module = createEmptyModule();
    const signature: FuncTypeDef = { kind: "func", params: [], results: [] };
    const functions = [
      wasmFunction("owner", 0),
      wasmFunction("owner__closure_0", 0),
      wasmFunction("owner__closure_1", 0),
    ];
    module.types.push(signature);
    module.functions.push(...functions);

    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
    const records = liftedUnitIds.map((id, ordinal) => ({
      id,
      parentId: owner.id,
      sourceId: owner.sourceId,
      terminalOwnerId: owner.terminalOwnerId,
      role: "lifted-closure" as const,
      ordinal,
    }));
    // Queue and plan in reverse producer order. Publication order must still
    // follow the explicit lifted ordinals beneath the owner's body.
    session.registerDerivedUnit(records[1]!);
    session.registerDerivedUnit(records[0]!);

    const refs = [
      irUnitFuncRef({ unitId: owner.id, name: functions[0]!.name }),
      ...liftedUnitIds.map((unitId, index) => irUnitFuncRef({ unitId, name: functions[index + 1]!.name })),
    ];
    const ids = [irUnitCallableBindingId(owner.id), ...liftedUnitIds.map(irUnitCallableBindingId)];
    for (const index of [2, 1, 0]) {
      expect(
        planProgramAbiUnitCallable(ctx, {
          ref: refs[index]!,
          signature,
          func: functions[index]!,
        }),
      ).toBe(ids[index]);
    }

    expect(ids.map((id) => session.getDraft(id)!.structuralOrder.derivedOrdinal)).toEqual([0, 1, 2]);
    const { abi } = session.publish(module);
    expect(
      abi
        .entries()
        .filter((entry) => entry.intent.kind === "callable")
        .map((entry) => entry.id),
    ).toEqual(ids);
    expect(ids.map((id) => abi.resolveFinalIndex(id))).toEqual([
      { space: "function", index: 0 },
      { space: "function", index: 1 },
      { space: "function", index: 2 },
    ]);
  });

  it("publishes the replacement object installed by production IR lowering", () => {
    const ast = analyzeSource("export function selected(value: number): number { return value + 1; }");
    const result = generateModule(ast, { experimentalIR: true, trackIrOutcomes: true });
    const hardErrors = result.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(result.irCompiledFuncs).toContain("selected");
    expect(result.programAbi).toBeDefined();

    const callable = result
      .programAbi!.abi.entries()
      .find((entry) => entry.intent.kind === "callable" && entry.displayName === "selected");
    expect(callable).toBeDefined();
    const localIndex = result.module.functions.findIndex((func) => func.name === "selected");
    const importCount = result.module.imports.filter((entry) => entry.desc.kind === "func").length;
    expect(result.programAbi!.abi.resolveFinalIndex(callable!.id)).toEqual({
      space: "function",
      index: importCount + localIndex,
    });
  });
});
