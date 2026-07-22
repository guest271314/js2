// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { getLastLinearIrReport, indexLinearIrSourceOwners } from "../src/ir/backend/linear-integration.js";
import {
  buildIrPlanningIdentityContext,
  IrLegacyUnitProjectionInvariantError,
  IrPlanningIdentityInvariantError,
  type IrPlanningIdentityContext,
} from "../src/ir/planning-identity.js";
import { ts } from "../src/ts-api.js";

const LINEAR_IR_FLAG = "JS2WASM_LINEAR_IR";
const savedLinearIrFlag = process.env[LINEAR_IR_FLAG];

afterEach(() => {
  if (savedLinearIrFlag === undefined) delete process.env[LINEAR_IR_FLAG];
  else process.env[LINEAR_IR_FLAG] = savedLinearIrFlag;
});

function source(fileName: string, text: string): ts.SourceFile {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
}

function context(files: readonly ts.SourceFile[], entry = files[0]!): IrPlanningIdentityContext {
  return buildIrPlanningIdentityContext(buildIrUnitInventory(files, { entrySource: entry }));
}

describe("#3520 linear integration owner identity", () => {
  it("keeps same-named source owners distinct and rejects a cross-context population", () => {
    const a = source("/repo/a.ts", `export function same(value: number): number { return value + 1; }`);
    const b = source("/repo/b.ts", `export function same(value: number): number { return value + 2; }`);
    const identityContext = context([a, b], a);
    const aIndex = indexLinearIrSourceOwners(a, identityContext);
    const bIndex = indexLinearIrSourceOwners(b, identityContext);

    expect(aIndex.owners).toHaveLength(1);
    expect(bIndex.owners).toHaveLength(1);
    expect(aIndex.owners[0]!.legacyName).toBe("same");
    expect(bIndex.owners[0]!.legacyName).toBe("same");
    expect(aIndex.owners[0]!.ownerUnitId).not.toBe(bIndex.owners[0]!.ownerUnitId);
    expect(aIndex.owners[0]!.declaration.getSourceFile()).toBe(a);
    expect(bIndex.owners[0]!.declaration.getSourceFile()).toBe(b);

    expect(() => indexLinearIrSourceOwners(b, context([a]))).toThrowError(
      expect.objectContaining<IrPlanningIdentityInvariantError>({ code: "source-record-mismatch" }),
    );
  });

  it("fails with the typed projection invariant when one source has an ambiguous legacy label", () => {
    const file = source(
      "/repo/ambiguous.ts",
      `
        function same(value: number): number { return value + 1; }
        function same(value: number): number { return value + 2; }
      `,
    );
    const identityContext = context([file]);

    expect(() => indexLinearIrSourceOwners(file, identityContext)).toThrowError(
      expect.objectContaining<IrLegacyUnitProjectionInvariantError>({ code: "duplicate-legacy-name" }),
    );
  });

  it("retains exact owners for compiled and rejected public name telemetry", async () => {
    delete process.env[LINEAR_IR_FLAG];
    const result = await compile(
      `
        export function accepted(value: number): number { return value + 1; }
        export function withDefault(value: number = 1): number { return value + 2; }
      `,
      { target: "linear", fileName: "linear-owner.ts" },
    );
    expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("; ")).toBe(true);

    const report = getLastLinearIrReport();
    expect(report?.compiled).toContain("accepted");
    const rejection = report?.rejected.find((candidate) => candidate.func === "withDefault");
    expect(rejection).toMatchObject({ reason: "select:param-shape-rejected" });

    const compiledOwner = report?.ownerEvidence.find(
      (evidence) => evidence.outcome === "compiled" && evidence.legacyName === "accepted",
    );
    const rejectedOwner = report?.ownerEvidence.find(
      (evidence) => evidence.outcome === "rejected" && evidence.legacyName === "withDefault",
    );
    expect(compiledOwner).toMatchObject({ outcome: "compiled", legacyName: "accepted" });
    expect(rejectedOwner).toMatchObject({ outcome: "rejected", legacyName: "withDefault", rejection });
    expect(compiledOwner?.ownerUnitId).toBeTruthy();
    expect(rejectedOwner?.ownerUnitId).toBeTruthy();
    expect(compiledOwner?.ownerUnitId).not.toBe(rejectedOwner?.ownerUnitId);
  });
});
