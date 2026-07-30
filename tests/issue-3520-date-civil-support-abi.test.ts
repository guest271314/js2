// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { SINGLE_HOST_ENTRIES } from "../scripts/check-ir-only.js";
import { analyzeSource } from "../src/checker/index.js";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { eliminateDeadLayoutAndPlanProgramAbi } from "../src/codegen/program-abi-finalization.js";
import {
  PROGRAM_ABI_CALLABLE_ROLE,
  resolveProgramAbiSupportCallableHandle,
} from "../src/codegen/program-abi-planning.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { eliminateDeadImports } from "../src/codegen/dead-elimination.js";
import { ensureDateCivilHelper } from "../src/codegen/expressions/builtins.js";
import { ensureLateImport, flushLateImportShifts } from "../src/codegen/expressions/late-imports.js";
import { definedFuncAt } from "../src/codegen/func-space.js";
import { generateModule } from "../src/codegen/index.js";
import { irSupportFuncRef } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, createIrBindingId } from "../src/ir/identity.js";
import { createEmptyModule } from "../src/ir/types.js";
import { compile } from "../src/index.js";
import { ts } from "../src/ts-api.js";

// Register the expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

const DATE_CIVIL_SUPPORT_ROLE = "date-civil-support";
const DATE_CIVIL_SUPPORT_ORDINAL = 0;
const DATE_CIVIL_HELPER = "__date_civil_from_days";

const CALENDAR_SOURCE = `
  export function stamp(): number {
    const value = new Date(Date.UTC(2024, 1, 29));
    return value.getUTCFullYear() * 10000 + (value.getUTCMonth() + 1) * 100 + value.getUTCDate();
  }
`;

function hardErrors(result: ReturnType<typeof generateModule>) {
  return result.errors.filter((error) => error.severity !== "warning");
}

function entrySourceRecord(source = CALENDAR_SOURCE) {
  const ast = analyzeSource(source, "issue-3520-date-civil-support.ts");
  return buildIrUnitInventory([ast.sourceFile], {
    entrySource: ast.sourceFile,
    checker: ast.checker,
  }).sources.find((candidate) => candidate.kind === "entry")!;
}

describe("#3520 C32 date civil support Program ABI ownership", () => {
  it("publishes one exact entry-source owner with no duplicate generic owner", () => {
    const ast = analyzeSource(CALENDAR_SOURCE, "issue-3520-date-civil-support.ts");
    const result = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
      standalone: true,
    });
    expect(
      hardErrors(result),
      hardErrors(result)
        .map((error) => error.message)
        .join("\n"),
    ).toEqual([]);
    expect(result.programAbi).toBeDefined();

    const entrySource = entrySourceRecord();
    const expectedId = createIrBindingId({
      ownerId: entrySource.id,
      domain: "support",
      role: DATE_CIVIL_SUPPORT_ROLE,
      ordinal: DATE_CIVIL_SUPPORT_ORDINAL,
    });
    const matchingEntries = result.programAbi!.abi.entries().filter((entry) => entry.displayName === DATE_CIVIL_HELPER);
    expect(matchingEntries).toHaveLength(1);
    expect(matchingEntries[0]).toMatchObject({
      id: expectedId,
      intent: {
        kind: "callable",
        origin: "support",
        sourceId: entrySource.id,
      },
    });

    const slot = result.programAbi!.abi.resolveFinalIndex(expectedId);
    expect(slot?.space).toBe("function");
    if (!slot || slot.space !== "function") throw new Error("missing date civil support slot");
    const importCount = result.module.imports.filter((entry) => entry.desc.kind === "func").length;
    expect(result.module.functions[slot.index - importCount]?.name).toBe(DATE_CIVIL_HELPER);
  });

  it("re-resolves the exact stable allocator after a late import and DCE compaction", () => {
    const sourceFile = ts.createSourceFile(
      "/repo/entry.ts",
      "export function entry(): number { return 1; }",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const inventory = buildIrUnitInventory([sourceFile], { entrySource: sourceFile });
    const entrySource = inventory.sources.find((source) => source.kind === "entry")!;
    const module = createEmptyModule();
    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);

    const stableHandle = ensureDateCivilHelper(ctx);
    const helper = definedFuncAt(ctx, stableHandle);
    expect(helper?.name).toBe(DATE_CIVIL_HELPER);
    const expectedId = createIrBindingId({
      ownerId: entrySource.id,
      domain: "support",
      role: DATE_CIVIL_SUPPORT_ROLE,
      ordinal: DATE_CIVIL_SUPPORT_ORDINAL,
    });
    expect(session.hasLocator(expectedId, helper)).toBe(true);
    expect(session.locatorBindingId(helper!)).toBe(expectedId);
    expect(session.getDraft(expectedId)?.structuralOrder).toMatchObject({
      roleOrdinal: PROGRAM_ABI_CALLABLE_ROLE.dateCivilSupport,
      derivedOrdinal: DATE_CIVIL_SUPPORT_ORDINAL,
    });
    const ref = irSupportFuncRef(
      entrySource.id,
      DATE_CIVIL_SUPPORT_ROLE,
      DATE_CIVIL_HELPER,
      DATE_CIVIL_SUPPORT_ORDINAL,
    );
    expect(resolveProgramAbiSupportCallableHandle(ctx, ref, helper!)).toBe(0);

    ensureLateImport(ctx, "unused_late_date_import", [], []);
    flushLateImportShifts(ctx, null);
    expect(ctx.numImportFuncs).toBe(1);
    expect(ensureDateCivilHelper(ctx)).toBe(stableHandle);
    expect(resolveProgramAbiSupportCallableHandle(ctx, ref, helper!)).toBe(1);

    eliminateDeadImports(module, ctx);
    expect(module.imports).toEqual([]);
    expect(ensureDateCivilHelper(ctx)).toBe(stableHandle);
    expect(resolveProgramAbiSupportCallableHandle(ctx, ref, helper!)).toBe(0);
    eliminateDeadLayoutAndPlanProgramAbi(ctx);
    ctx.indexSpaceFrozen = true;
    const publication = session.publish(module);
    expect(publication.abi.resolveFinalIndex(expectedId)).toEqual({ space: "function", index: 0 });
    expect(module.functions[0]).toBe(helper);
  });

  it("does not claim a same-named pre-existing allocator as Date support", () => {
    const sourceFile = ts.createSourceFile(
      "/repo/entry.ts",
      "export function entry(): number { return 1; }",
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const inventory = buildIrUnitInventory([sourceFile], { entrySource: sourceFile });
    const entrySource = inventory.sources.find((source) => source.kind === "entry")!;
    const module = createEmptyModule();
    module.types.push({ kind: "func", params: [{ kind: "i64" }], results: [{ kind: "i64" }] });
    const occupied = {
      name: DATE_CIVIL_HELPER,
      typeIdx: 0,
      locals: [],
      body: [{ op: "local.get" as const, index: 0 }],
      exported: false,
    };
    module.functions.push(occupied);
    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
    ctx.funcMap.set(DATE_CIVIL_HELPER, 0);

    expect(ensureDateCivilHelper(ctx)).toBe(0);
    const dateId = createIrBindingId({
      ownerId: entrySource.id,
      domain: "support",
      role: DATE_CIVIL_SUPPORT_ROLE,
      ordinal: DATE_CIVIL_SUPPORT_ORDINAL,
    });
    expect(session.getDraft(dateId)).toBeUndefined();
    eliminateDeadLayoutAndPlanProgramAbi(ctx);
    ctx.indexSpaceFrozen = true;
    const entries = session.publish(module).abi.entries();
    expect(entries.some((entry) => entry.id === dateId)).toBe(false);
    expect(entries.filter((entry) => entry.displayName === DATE_CIVIL_HELPER)).toHaveLength(1);
    expect(session.locatorBindingId(occupied)).toContain("retained-module-function");
  });

  it("keeps tracked and untracked Date modules byte-identical", async () => {
    const options = {
      fileName: "issue-3520-date-civil-byte-parity.ts",
      experimentalIR: true,
      target: "standalone",
    } as const;
    const untracked = await compile(CALENDAR_SOURCE, options);
    const tracked = await compile(CALENDAR_SOURCE, { ...options, trackIrOutcomes: true });
    expect(untracked.success, untracked.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(tracked.success, tracked.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(tracked.binary).toEqual(untracked.binary);
  });

  it("preserves leap-day calendar behavior", async () => {
    const result = await compile(CALENDAR_SOURCE, {
      fileName: "issue-3520-date-civil-runtime.ts",
      experimentalIR: true,
      trackIrOutcomes: true,
      target: "standalone",
    });
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(result.imports).toEqual([]);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.stamp as () => number)()).toBe(20240229);
  });

  it("moves one five-entry census row without changing functions or terminal routing", () => {
    let definedFunctions = 0;
    let genericRows = 0;
    let dateRows = 0;
    let vecRows = 0;
    let terminalUnits = 0;
    let emitted = 0;
    let unsupported = 0;
    let invariants = 0;
    let legacyBodies = 0;
    let irBodies = 0;

    for (const entry of SINGLE_HOST_ENTRIES) {
      const source = readFileSync(resolve(entry), "utf8");
      const ast = analyzeSource(source, entry);
      const result = generateModule(ast, {
        experimentalIR: true,
        trackIrOutcomes: true,
      });
      const errors = hardErrors(result);
      expect(errors, `${entry}\n${errors.map((error) => error.message).join("\n")}`).toEqual([]);
      definedFunctions += result.module.functions.length;
      const entries = result.programAbi!.abi.entries();
      genericRows += entries.filter((candidate) => candidate.id.includes("retained-module-function")).length;
      dateRows += entries.filter((candidate) => candidate.id.includes(`:${DATE_CIVIL_SUPPORT_ROLE}:`)).length;
      vecRows += entries.filter((candidate) => candidate.id.includes(":vec-host-bridge:")).length;
      for (const outcome of result.irOutcomes ?? []) {
        terminalUnits++;
        if (outcome.kind === "emitted") emitted++;
        if (outcome.kind === "unsupported") unsupported++;
        if (outcome.kind === "invariant") invariants++;
        if (outcome.legacyBodyEmitted) legacyBodies++;
        if (outcome.irBodyEmitted) irBodies++;
      }
    }

    expect({ definedFunctions, dateRows }).toEqual({ definedFunctions: 166, dateRows: 1 });
    // C30 is an independent ownership slice. Composed with its 24 vec rows,
    // C31+C32 retain 50 generic rows; without C30 this stack retains 74.
    expect([0, 24]).toContain(vecRows);
    expect(genericRows).toBe(74 - vecRows);
    expect({ terminalUnits, emitted, unsupported, invariants, legacyBodies, irBodies }).toEqual({
      terminalUnits: 37,
      emitted: 30,
      unsupported: 7,
      invariants: 0,
      legacyBodies: 37,
      irBodies: 30,
    });
  });
});
