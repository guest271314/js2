// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { analyzeMultiSource, analyzeSource } from "../src/checker/index.js";
import { generateModule, generateMultiModule } from "../src/codegen/index.js";
import { compile, compileMulti, type CompileResult } from "../src/index.js";
import { irUnitCallableBindingId } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, type IrUnitInventory, type IrUnitRecord } from "../src/ir/identity.js";
import type { ProgramAbiPlanEntry } from "../src/ir/program-abi.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

// Register the codegen expression/statement delegates used by generateModule.
import "../src/codegen/expressions.js";

function exactUnit(inventory: IrUnitInventory, kind: string, displayName: string): IrUnitRecord {
  const matches = inventory.allUnits.filter((unit) => unit.kind === kind && unit.displayName === displayName);
  if (matches.length !== 1) {
    throw new Error(`expected one ${kind} ${displayName}, found ${matches.length}`);
  }
  return matches[0]!;
}

function requiredCallable(entries: readonly ProgramAbiPlanEntry[], bindingId: string): ProgramAbiPlanEntry {
  const entry = entries.find((candidate) => candidate.id === bindingId);
  if (!entry) throw new Error(`missing callable ABI entry ${bindingId}`);
  expect(entry).toMatchObject({
    slotPolicy: "required",
    slotSpace: "function",
    intent: { kind: "callable", origin: "source" },
  });
  return entry;
}

async function instantiate(result: CompileResult): Promise<Record<string, WebAssembly.ExportValue>> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await instantiateWasm(
    result.binary,
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  imports.setExports?.(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, WebAssembly.ExportValue>;
}

describe("#3520 top-level source callable Program ABI ownership", () => {
  it("owns an Unsupported retained direct body by its exact source unit", async () => {
    const source = `export function withDefault(value: number = 1): number { return value; }`;
    const ast = analyzeSource(source, "source-callable-unsupported.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const unit = exactUnit(inventory, "top-level-function", "withDefault");
    const generated = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const hardErrors = generated.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(generated.irOutcomes?.find((outcome) => outcome.unitId === unit.id)).toMatchObject({
      kind: "unsupported",
      code: "param-shape-rejected",
      legacyBodyEmitted: true,
      irBodyEmitted: false,
    });

    const bindingId = irUnitCallableBindingId(unit.id);
    const entry = requiredCallable(generated.programAbi!.abi.entries(), bindingId);
    expect(entry.intent).toMatchObject({ kind: "callable", unitId: unit.id });

    const runtime = await compile(source, {
      fileName: "source-callable-unsupported.ts",
      experimentalIR: true,
    });
    const exports = await instantiate(runtime);
    expect((exports.withDefault as (value: number) => number)(7)).toBe(7);
  });

  it("keeps the exact source owner when IR replaces the preallocated body", async () => {
    const source = `export function double(value: number): number { return value * 2; }`;
    const ast = analyzeSource(source, "source-callable-ir.ts");
    const inventory = buildIrUnitInventory([ast.sourceFile], {
      entrySource: ast.sourceFile,
      checker: ast.checker,
    });
    const unit = exactUnit(inventory, "top-level-function", "double");
    const generated = generateModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const hardErrors = generated.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(generated.irOutcomes?.find((outcome) => outcome.unitId === unit.id)).toMatchObject({
      kind: "emitted",
      irBodyEmitted: true,
    });

    const bindingId = irUnitCallableBindingId(unit.id);
    const entry = requiredCallable(generated.programAbi!.abi.entries(), bindingId);
    expect(entry.intent).toMatchObject({ kind: "callable", unitId: unit.id });
    expect(generated.programAbi!.abi.resolveFinalIndex(bindingId)).toEqual(
      expect.objectContaining({ space: "function" }),
    );

    const runtime = await compile(source, {
      fileName: "source-callable-ir.ts",
      experimentalIR: true,
    });
    const exports = await instantiate(runtime);
    expect((exports.double as (value: number) => number)(9)).toBe(18);
  });

  it("keeps same-named retained functions source-qualified across a multi-source collision", async () => {
    const files = {
      "dependency.ts": `
        export function shared(value: number): number { return value + 1; }
        export function depCaller(value: number): number { return shared(value); }
      `,
      "entry.ts": `
        import { depCaller } from "./dependency.ts";
        function shared(value: number): number { return value + 10; }
        export function entryCaller(value: number): number { return shared(value); }
        export function runDep(value: number): number { return depCaller(value); }
      `,
    };
    const ast = analyzeMultiSource(files, "entry.ts");
    const inventory = buildIrUnitInventory(ast.sourceFiles, {
      entrySource: ast.entryFile,
      checker: ast.checker,
    });
    const sharedUnits = inventory.allUnits.filter(
      (unit) => unit.kind === "top-level-function" && unit.displayName === "shared",
    );
    expect(sharedUnits).toHaveLength(2);

    const generated = generateMultiModule(ast, {
      experimentalIR: true,
      trackIrOutcomes: true,
    });
    const hardErrors = generated.errors.filter((error) => error.severity !== "warning");
    expect(hardErrors, hardErrors.map((error) => error.message).join("\n")).toEqual([]);
    expect(new Set(generated.irCompiledFuncs ?? []).has("shared")).toBe(false);

    const entries = generated.programAbi!.abi.entries();
    const sharedBindings = sharedUnits.map((unit) => {
      const bindingId = irUnitCallableBindingId(unit.id);
      const entry = requiredCallable(entries, bindingId);
      expect(entry.intent).toMatchObject({ kind: "callable", unitId: unit.id });
      return { bindingId, slot: generated.programAbi!.abi.resolveFinalIndex(bindingId) };
    });
    expect(sharedBindings[0]!.slot).toEqual(expect.objectContaining({ space: "function" }));
    expect(sharedBindings[1]!.slot).toEqual(expect.objectContaining({ space: "function" }));
    expect(sharedBindings[0]!.slot).not.toEqual(sharedBindings[1]!.slot);
    expect(() => generated.programAbi!.legacy.resolveUniqueLegacyName("function", "shared")).toThrow(
      /matches 2 canonical structural owners/,
    );

    const runtime = await compileMulti(files, "entry.ts", { experimentalIR: true });
    const exports = await instantiate(runtime);
    expect((exports.entryCaller as (value: number) => number)(7)).toBe(17);
    expect((exports.runDep as (value: number) => number)(7)).toBe(8);
  });
});
